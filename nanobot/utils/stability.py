import datetime
import os
from pathlib import Path

STABILITY_LOG_PATH = Path.home() / ".nanobot" / "STABILITY.md"

def log_stability_event(event_type: str, details: str):
    """
    Log a stability event (error, retry, circuit breaker trip) to STABILITY.md.
    """
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    entry = f"| {timestamp} | {event_type} | {details} |\n"
    
    try:
        # Ensure parent directory exists
        STABILITY_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        
        # Initialize file with header if not exists (atomic check via open mode)
        if not STABILITY_LOG_PATH.exists():
            header = "# Nanobot Stability Log\n\n| Timestamp | Event Type | Details |\n|-----------|------------|---------||\n"
            try:
                # Use 'x' mode for atomic creation (fails if file already exists)
                with open(STABILITY_LOG_PATH, "x", encoding="utf-8") as f:
                    f.write(header)
            except FileExistsError:
                pass  # Another process created it first — safe to proceed
            
        # Append entry
        with open(STABILITY_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(entry)
    except Exception as e:
        # Fallback to stderr if file log fails
        import sys
        print(f"Failed to log to STABILITY.md: {e}", file=sys.stderr)
