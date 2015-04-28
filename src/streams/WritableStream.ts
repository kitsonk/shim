import * as util from './util';
import { Sink, Strategy } from './interfaces';
import SizeQueue from './SizeQueue';
import Promise from '../Promise';

var SinkMethod = {
	abort: 'abort',
	close: 'close',
	start: 'start',
	write: 'write'
};

interface Record<T> {
	close?: boolean;
	chunk?: T;
	reject?: (error: Error) => void;
	resolve?: () => void;
}

export default class WritableStream<T> {
	protected _advancing: boolean;
	protected _closedPromise: Promise<void>;
	protected _queue: SizeQueue<Record<T>>;
	protected _rejectClosedPromise: (error: Error) => void;
	protected _resolveClosedPromise: () => void;
	protected _readyPromise: Promise<void>;
	protected _rejectReadyPromise: (error: Error) => void;
	protected _resolveReadyPromise: () => void;
	protected _started: boolean;
	protected _startedPromise: Promise<any>;
	protected _state: State;
	protected _storedError: Error;
	protected _strategy: Strategy<T>;
	protected _underlyingSink: Sink<T>;
	protected _writing: boolean;

	constructor(underlyingSink: Sink<T>, strategy: Strategy<T> = {}) {
		this._underlyingSink = underlyingSink;

		this._closedPromise = new Promise<void>((resolve, reject) => {
			this._resolveClosedPromise = resolve;
			this._rejectClosedPromise = reject;
		});

		this._advancing = false;
		this._readyPromise = Promise.resolve();
		this._queue = new SizeQueue<Record<T>>();
		this._state = State.Writable;
		this._started = false;
		this._writing = false;
		this._strategy = util.normalizeStrategy(strategy);
		this._syncStateWithQueue();

		this._startedPromise = util.invokeOrNoop(this._underlyingSink, SinkMethod.start).then(() => {
			this._started = true;
			this._startedPromise = undefined;
		}, (error: Error) => {
			this._error(error);
		});
	}

	abort(reason: any): Promise<void> {
		if (!this._isWritable()) {
			// 4.2.4.4-1
			return Promise.reject(new TypeError('Must be a WritableStream'));
		}

		if (this.state === State.Closed) {
			// 4.2.4.4-2
			return Promise.resolve();
		}

		if (this.state === State.Errored) {
			// 4.2.4.4-3
			return Promise.reject(this._storedError);
		}

		var error: Error = reason instanceof Error ? reason : new Error(reason);

		this._error(error);

		return util.promiseInvokeOrFallbackOrNoop(this._underlyingSink, SinkMethod.abort, [reason], SinkMethod.close)
			.then(() => {
			return;
		});
	}

	write(chunk: T): Promise<void> {
		// 4.2.4.6-1
		if (!this._isWritable() ||
			// 4.2.4.6-2
			this.state === State.Closed ||
			this.state === State.Closing
		) {
			return Promise.reject(new TypeError('Must be a WritableStream'));
		}

		if (this.state === State.Errored) {
			// 4.2.4.6-3
			return Promise.reject(this._storedError);
		}

		var chunkSize = 1;
		var writeRecord: Record<T>;
		var promise = new Promise<void>((resolve, reject) => {
			writeRecord = {
				chunk: chunk,
				reject: reject,
				resolve: resolve
			};
		});

		// 4.2.4.6-6.b
		try {
			if (this._strategy && this._strategy.size) {
				chunkSize = this._strategy.size(chunk);
			}

			this._queue.enqueue(writeRecord, chunkSize);
			this._syncStateWithQueue();
		}
		catch (error) {
			// 4.2.4.6-6.b, 4.2.4.6-10, 4.2.4.6-12
			this._error(error);
			return Promise.reject(error);
		}

		this._advanceQueue();

		return promise;
	}

	close(): Promise<void> {
		// 4.2.4.5-1
		if (!this._isWritable() ||
			// 4.2.4.5-2
			this.state === State.Closed ||
			this.state === State.Closing
		) {
			return Promise.reject(new TypeError('Must be a WritableStream'));
		}

		if (this.state === State.Errored) {
			// 4.2.4.5-3
			return Promise.reject(this._storedError);
		}

		if (this.state === State.Waiting) {
			// 4.2.4.5-4
			this._resolveReadyPromise();
		}

		this._state = State.Closing;

		this._queue.enqueue({ close: true }, 0);

		this._advanceQueue();

		return this._closedPromise;
	}

	get closed(): Promise<void> {
		if (this._isWritable()) {
			return this._closedPromise;
		}
		else {
			// 4.2.4.1-1
			return Promise.reject(new TypeError('Must be a WritableStream'));
		}
	}

	get ready(): Promise<void> {
		if (this._isWritable()) {
			return this._readyPromise;
		}
		else {
			// 4.2.4.2-1
			return Promise.reject(new TypeError('Must be a WritableStream'));
		}
	}

	get state(): State {
		if (this._isWritable()) {
			return this._state;
		}
		else {
			// 4.2.4.3-1
			throw new TypeError('Must be a WritableStream');
		}
	}

	// This method combines the logic of two methods:
	// 4.3.1 CallOrScheduleWritableStreamAdvanceQueue
	// 4.3.6 WritableStreamAdvanceQueue
	protected _advanceQueue() {
		if (!this._started) {
			if (!this._advancing) {
				this._advancing = true;
				this._startedPromise.then(() => {
					this._advanceQueue();
				});
			}

			return;
		}

		if (!this._queue || this._writing) {
			return;
		}

		var writeRecord: Record<T> = this._queue.peek();

		if (writeRecord.close) {
			// TODO: SKIP? Assert 4.3.6-3.a
			if (this.state !== State.Closing) {
				throw new Error('Invalid record');
			}

			this._queue.dequeue();
			// TODO: SKIP? Assert 4.3.6-3.c
			this._close();

			return;
		}

		this._writing = true;

		util.promiseInvokeOrNoop(this._underlyingSink, SinkMethod.write, [ writeRecord.chunk ]).then(() => {
			if (this.state !== State.Errored) {
				this._writing = false;
				writeRecord.resolve();
				this._queue.dequeue();

				try {
					this._syncStateWithQueue();
				}
				catch (error) {
					return this._error(error);
				}

				this._advanceQueue();
			}
		}, (error: Error) => {
			this._error(error);
		});
	}

	// 4.3.2 CloseWritableStream
	protected _close(): void {
		if (this.state !== State.Closing) {
			// 4.3.2-1
			throw new Error('WritableStream#_close called while state is not "Closing"');
		}

		util.promiseInvokeOrNoop(this._underlyingSink, SinkMethod.close).then(() => {
			if (this.state !== State.Errored) {
				// TODO: Assert 4.3.2.2-a.ii
				this._resolveClosedPromise();
				this._state = State.Closed;
			}
		}, (error: Error) => {
			this._error(error);
		});
	}

	// 4.3.3 ErrorWritableStream
	protected _error(error: Error) {
		if (this.state === State.Closed || this.state === State.Errored) {
			return;
		}

		var writeRecord: Record<T>;

		while (this._queue.length) {
			writeRecord = this._queue.dequeue();

			if (!writeRecord.close) {
				writeRecord.reject(error);
			}
		}

		this._storedError = error;

		if (this.state === State.Waiting) {
			this._resolveReadyPromise();
		}

		this._rejectClosedPromise(error);
		this._state = State.Errored;
	}

	protected _isWritable(): boolean {
		return this._underlyingSink != null;
	}

	// 4.3.5 SyncWritableStreamStateWithQueue
	protected _syncStateWithQueue(): void {
		if (this.state === State.Closing) {
			return;
		}

		var queueSize = this._queue.length;

		if (!queueSize) {
			return;
		}

		var shouldApplyBackPressure = queueSize > this._strategy.highwaterMark;

		if (shouldApplyBackPressure && this.state === State.Writable) {
			this._state = State.Waiting;
			this._readyPromise = new Promise<void>((resolve, reject) => {
				this._resolveReadyPromise = resolve;
				this._rejectReadyPromise = reject;
			});
		}

		if (shouldApplyBackPressure === false && this.state === State.Waiting) {
			this._state = State.Writable;
			this._resolveReadyPromise();
		}
	}
}

/**
 * WritableStream's possible states
 */
export enum State { Closed, Closing, Errored, Waiting, Writable }