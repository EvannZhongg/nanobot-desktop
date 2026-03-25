"""Global network utility for retries and timeouts."""

import asyncio
import functools
from typing import Any, Callable, Type, TypeVar, Coroutine
from loguru import logger
from nanobot.utils.stability import log_stability_event

T = TypeVar("T")

async def async_retry(
    func: Callable[..., Coroutine[Any, Any, T]],
    retries: int = 3,
    backoff: float = 2.0,
    exceptions: tuple[Type[Exception], ...] = (Exception,),
    name: str = "Request",
    retry_on_status: tuple[int, ...] = (429, 500, 502, 503, 504),
    timeout: float = 60.0,
) -> T:
    """
    Retry an async function with exponential backoff, error categorization,
    and per-attempt timeout protection.
    """
    import httpx
    
    delay = 1.0
    max_delay = 30.0  # Cap backoff to prevent unbounded growth
    for i in range(retries + 1):
        try:
            # Enforce per-attempt timeout to prevent hung connections
            return await asyncio.wait_for(func(), timeout=timeout)
        except asyncio.TimeoutError:
            if i == retries:
                logger.error(f"{name} timed out after {timeout}s on attempt {i+1}")
                log_stability_event("TIMEOUT", f"{name} timed out after {timeout}s, {retries} retries exhausted.")
                raise
            logger.warning(f"{name} timeout on attempt {i+1}/{retries}, retrying in {delay}s...")
            await asyncio.sleep(delay)
            delay = min(delay * backoff, max_delay)
        except exceptions as e:
            # Categorize error
            should_retry = True
            
            # Check for HTTP status codes if it's an httpx error
            if isinstance(e, httpx.HTTPStatusError):
                if e.response.status_code not in retry_on_status:
                    should_retry = False
            
            # Don't retry on certain fatal errors
            if "unauthorized" in str(e).lower() or "forbidden" in str(e).lower():
                should_retry = False
                
            if not should_retry or i == retries:
                logger.error(f"{name} failed: {e}")
                log_stability_event("RETRY_FAILURE", f"{name} exhausted {retries} retries. Final error: {e}")
                raise
            
            logger.warning(f"{name} retry {i+1}/{retries} after {delay}s due to: {e}")
            await asyncio.sleep(delay)
            delay = min(delay * backoff, max_delay)
    
    raise RuntimeError("Retry loop logic failed")


def with_retry(retries: int = 3, backoff: float = 2.0, exceptions: tuple[Type[Exception], ...] = (Exception,), name: str | None = None):
    """Decorator version of async_retry."""
    def decorator(func: Callable[..., Coroutine[Any, Any, T]]):
        @functools.wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            async def wrapped_func():
                return await func(*args, **kwargs)
            return await async_retry(wrapped_func, retries, backoff, exceptions, name or func.__name__)
        return wrapper
    return decorator

class CircuitBreaker:
    """
    Prevents cascading failures by stopping requests to a failing service.
    """
    def __init__(self, failure_threshold: int = 5, recovery_timeout: float = 60.0, name: str = "Generic"):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.failure_count = 0
        self.last_failure_time = 0.0
        self.state = "CLOSED"  # CLOSED, OPEN, HALF_OPEN
        self.name = name

    def record_success(self):
        self.failure_count = 0
        self.state = "CLOSED"

    def record_failure(self):
        import time
        self.failure_count += 1
        self.last_failure_time = time.time()
        if self.failure_count >= self.failure_threshold:
            self.state = "OPEN"
            logger.warning(f"Circuit Breaker [{self.name}] OPEN after {self.failure_count} failures")
            log_stability_event("CIRCUIT_OPEN", f"Breaker [{self.name}] tripped after {self.failure_count} consecutive failures.")

    def can_execute(self) -> bool:
        import time
        if self.state == "CLOSED":
            return True
        if self.state == "OPEN":
            if time.time() - self.last_failure_time > self.recovery_timeout:
                self.state = "HALF_OPEN"
                return True
            return False
        return True  # HALF_OPEN

def with_breaker(breaker: CircuitBreaker):
    """Decorator to wrap a function with a circuit breaker."""
    def decorator(func: Callable[..., Coroutine[Any, Any, T]]):
        @functools.wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            if not breaker.can_execute():
                raise RuntimeError(f"Circuit Breaker [{breaker.name}] is OPEN for {func.__name__}")
            try:
                result = await func(*args, **kwargs)
                breaker.record_success()
                return result
            except Exception:
                breaker.record_failure()
                raise
        return wrapper
    return decorator
