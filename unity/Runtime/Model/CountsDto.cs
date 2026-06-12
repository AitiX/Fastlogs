// Session log counters, per the wire contract `counts` object.

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Per-session log counters (NOT limited to what is in the ring buffer).
    /// Maps to the contract `counts` object: { error, warn, log }.
    /// </summary>
    public struct CountsDto
    {
        public int Error;
        public int Warn;
        public int Log;

        public CountsDto(int error, int warn, int log)
        {
            Error = error;
            Warn = warn;
            Log = log;
        }

        /// <summary>Total of all three counters.</summary>
        public int Total
        {
            get { return Error + Warn + Log; }
        }

        public override string ToString()
        {
            return "E:" + Error + " W:" + Warn + " L:" + Log;
        }
    }
}
