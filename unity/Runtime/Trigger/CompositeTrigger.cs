// CompositeTrigger - fires when ANY of its child triggers fires (logical OR).
//
// Lets the builder combine, e.g., a corner multi-tap (mobile) with a key combo
// (Editor / standalone) behind a single ITriggerSource. Configure and Dispose
// fan out to all children; Poll returns true if any child returns true this
// frame. All children are polled every frame so each can maintain its own edge
// state correctly (no short-circuit).
//
// Gated: the whole file compiles only where FastLogs is enabled.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using System.Collections.Generic;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Combines several <see cref="ITriggerSource"/> instances with OR semantics.
    /// Null children are ignored. Exceptions from one child do not stop the others.
    /// </summary>
    public sealed class CompositeTrigger : ITriggerSource
    {
        private readonly List<ITriggerSource> _children = new List<ITriggerSource>();

        public CompositeTrigger(params ITriggerSource[] children)
        {
            if (children != null)
            {
                for (int i = 0; i < children.Length; i++)
                {
                    if (children[i] != null)
                    {
                        _children.Add(children[i]);
                    }
                }
            }
        }

        /// <summary>Add a child trigger after construction. Null is ignored.</summary>
        public void Add(ITriggerSource child)
        {
            if (child != null)
            {
                _children.Add(child);
            }
        }

        public void Configure(TriggerConfig config)
        {
            for (int i = 0; i < _children.Count; i++)
            {
                try { _children[i].Configure(config); }
                catch (Exception e) { FlogLog.Exception(e); }
            }
        }

        public bool Poll()
        {
            // Poll EVERY child (no short-circuit) so each updates its own edge
            // state; OR the results.
            bool fired = false;
            for (int i = 0; i < _children.Count; i++)
            {
                try
                {
                    if (_children[i].Poll())
                    {
                        fired = true;
                    }
                }
                catch (Exception e)
                {
                    FlogLog.Exception(e);
                }
            }
            return fired;
        }

        public void Dispose()
        {
            for (int i = 0; i < _children.Count; i++)
            {
                try { _children[i].Dispose(); }
                catch (Exception e) { FlogLog.Exception(e); }
            }
            _children.Clear();
        }
    }
}
#endif
