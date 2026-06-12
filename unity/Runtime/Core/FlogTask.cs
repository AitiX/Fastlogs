// FlogTask<T> - FastLogs' minimal awaitable result handle.
//
// Why not Task<T> or Awaitable?
//   - Unity 6 has UnityEngine.Awaitable; Unity 2022.3 does not. We must compile
//     on both, so the public async surface cannot depend on Awaitable.
//   - On WebGL there are no threads: all "async" work is driven by coroutines on
//     the main thread. A System.Threading.Tasks.Task would be awkward to complete
//     from a coroutine and risks ConfigureAwait/SynchronizationContext pitfalls.
//
// FlogTask<T> is therefore a tiny, main-thread, coroutine-friendly future:
//   - Producers (uploader, screenshot capturer) create one with FlogTask.Create<T>(),
//     run their coroutine, then call SetResult / SetException.
//   - Consumers can `await` it (custom awaiter, no extra dependencies) OR poll
//     IsCompleted / register a continuation. The awaiter resumes the continuation
//     on the captured SynchronizationContext when available, else inline (the
//     producer always completes on the main thread, so inline is safe on WebGL).
//
// This keeps the whole package free of Awaitable / threading assumptions while
// still letting game code write `var r = await FastLogs.SendAsync(...)`.

using System;
using System.Runtime.CompilerServices;
using System.Threading;

namespace PlayJoy.FastLogs
{
    /// <summary>Non-generic helpers / completed-task factories.</summary>
    public static class FlogTask
    {
        public static FlogTask<T> FromResult<T>(T value)
        {
            var t = new FlogTask<T>();
            t.SetResult(value);
            return t;
        }

        public static FlogTask<T> FromException<T>(Exception error)
        {
            var t = new FlogTask<T>();
            t.SetException(error);
            return t;
        }

        public static FlogTask<T> Create<T>()
        {
            return new FlogTask<T>();
        }
    }

    /// <summary>
    /// A minimal awaitable future completed from the main thread (typically from a
    /// coroutine). Awaitable on all Unity versions without Awaitable/Task.
    /// </summary>
    public sealed class FlogTask<T>
    {
        private enum State { Pending, Succeeded, Faulted }

        private State _state = State.Pending;
        private T _result;
        private Exception _exception;
        private Action _continuation;
        private SynchronizationContext _continuationContext;

        public bool IsCompleted
        {
            get { return _state != State.Pending; }
        }

        public bool IsFaulted
        {
            get { return _state == State.Faulted; }
        }

        public T Result
        {
            get
            {
                if (_state == State.Faulted)
                {
                    throw _exception ?? new Exception("FlogTask faulted.");
                }
                return _result;
            }
        }

        public Exception Exception
        {
            get { return _exception; }
        }

        public void SetResult(T value)
        {
            if (_state != State.Pending)
            {
                return; // idempotent: ignore double-completion
            }
            _result = value;
            _state = State.Succeeded;
            InvokeContinuation();
        }

        public void SetException(Exception error)
        {
            if (_state != State.Pending)
            {
                return;
            }
            _exception = error ?? new Exception("FlogTask faulted.");
            _state = State.Faulted;
            InvokeContinuation();
        }

        private void InvokeContinuation()
        {
            var continuation = _continuation;
            _continuation = null;
            if (continuation == null)
            {
                return;
            }

            var ctx = _continuationContext;
            _continuationContext = null;

            if (ctx != null && ctx != SynchronizationContext.Current)
            {
                ctx.Post(_ => continuation(), null);
            }
            else
            {
                // Producer completes on the main thread; inline is safe (and the
                // only option on WebGL where there is no real SynchronizationContext).
                continuation();
            }
        }

        // ---- await support ----

        public Awaiter GetAwaiter()
        {
            return new Awaiter(this);
        }

        /// <summary>Custom awaiter - no Task/Awaitable dependency.</summary>
        public readonly struct Awaiter : INotifyCompletion
        {
            private readonly FlogTask<T> _task;

            public Awaiter(FlogTask<T> task)
            {
                _task = task;
            }

            public bool IsCompleted
            {
                get { return _task.IsCompleted; }
            }

            public T GetResult()
            {
                return _task.Result;
            }

            public void OnCompleted(Action continuation)
            {
                if (continuation == null)
                {
                    return;
                }

                if (_task.IsCompleted)
                {
                    continuation();
                    return;
                }

                _task._continuation = continuation;
                _task._continuationContext = SynchronizationContext.Current;
            }
        }
    }
}
