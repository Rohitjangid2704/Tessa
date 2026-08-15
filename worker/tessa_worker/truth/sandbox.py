import ctypes
import threading
from collections.abc import Callable
from typing import Any

from jinja2 import StrictUndefined, TemplateError
from jinja2.exceptions import SecurityError
from jinja2.runtime import Context
from jinja2.sandbox import ImmutableSandboxedEnvironment

MAX_TEMPLATE_CHARS = 8000
MAX_OUTPUT_CHARS = 20000
MAX_RANGE_LENGTH = 10000
MAX_REPEAT_LENGTH = 10000
MAX_EXPONENT = 64
RENDER_TIMEOUT_SECONDS = 2.0
INTERRUPT_GRACE_SECONDS = 1.0
REMOVED_GLOBALS = ("lipsum",)
REPEATED_TYPES = (str, bytes, list, tuple)


class RenderError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class RenderTimeoutError(RenderError):
    def __init__(self, timeout_seconds: float = RENDER_TIMEOUT_SECONDS) -> None:
        super().__init__(f"rendering took longer than {timeout_seconds:g} seconds")


def bounded_range(*arguments: int) -> range:
    produced = range(*arguments)
    if len(produced) > MAX_RANGE_LENGTH:
        raise SecurityError(f"range() may produce at most {MAX_RANGE_LENGTH} items")
    return produced


def repeats_too_much(left: Any, right: Any) -> bool:
    for sequence, count in ((left, right), (right, left)):
        if isinstance(sequence, REPEATED_TYPES) and isinstance(count, int):
            return len(sequence) * max(count, 0) > MAX_REPEAT_LENGTH
    return False


class OracleTemplateEnvironment(ImmutableSandboxedEnvironment):
    intercepted_binops = frozenset({"*", "**"})

    def __init__(self) -> None:
        super().__init__(undefined=StrictUndefined, autoescape=False, trim_blocks=True)
        for name in REMOVED_GLOBALS:
            self.globals.pop(name, None)
        self.globals["range"] = bounded_range

    def call_binop(self, context: Context, operator: str, left: Any, right: Any) -> Any:
        if operator == "**" and isinstance(right, int | float) and abs(right) > MAX_EXPONENT:
            raise SecurityError(f"exponents above {MAX_EXPONENT} are not allowed")
        if operator == "*" and repeats_too_much(left, right):
            raise SecurityError(f"repeating a value beyond {MAX_REPEAT_LENGTH} items is blocked")
        return super().call_binop(context, operator, left, right)


def interrupt_thread(thread: threading.Thread, error_type: type[BaseException]) -> None:
    identifier = thread.ident
    if identifier is not None:
        ctypes.pythonapi.PyThreadState_SetAsyncExc(
            ctypes.c_ulong(identifier), ctypes.py_object(error_type)
        )


def run_with_deadline[T](function: Callable[[], T], timeout_seconds: float) -> T:
    results: list[T] = []
    errors: list[BaseException] = []

    def target() -> None:
        try:
            results.append(function())
        except BaseException as error:
            errors.append(error)

    worker = threading.Thread(target=target, name="oracle-render", daemon=True)
    worker.start()
    worker.join(timeout_seconds)
    if worker.is_alive():
        interrupt_thread(worker, RenderTimeoutError)
        worker.join(INTERRUPT_GRACE_SECONDS)
        raise RenderTimeoutError(timeout_seconds)
    if errors:
        raise errors[0]
    return results[0]


def describe_template_error(error: Exception) -> str:
    if isinstance(error, SecurityError):
        return f"the template is not allowed to do that: {error}"
    if isinstance(error, TemplateError):
        return f"{type(error).__name__}: {error.message}"
    return f"{type(error).__name__}: {error}"


def render_template(
    template_text: str,
    variables: dict[str, Any],
    timeout_seconds: float = RENDER_TIMEOUT_SECONDS,
) -> str:
    if len(template_text) > MAX_TEMPLATE_CHARS:
        raise RenderError(f"the template is longer than {MAX_TEMPLATE_CHARS} characters")

    def render() -> str:
        return OracleTemplateEnvironment().from_string(template_text).render(**variables)

    try:
        text = run_with_deadline(render, timeout_seconds)
    except RenderError:
        raise
    except Exception as error:
        raise RenderError(describe_template_error(error)) from None
    if len(text) > MAX_OUTPUT_CHARS:
        raise RenderError(f"the rendered text is longer than {MAX_OUTPUT_CHARS} characters")
    return text


def evaluate_expression(
    expression: str,
    variables: dict[str, Any],
    timeout_seconds: float = RENDER_TIMEOUT_SECONDS,
) -> Any:
    if len(expression) > MAX_TEMPLATE_CHARS:
        raise RenderError(f"the expression is longer than {MAX_TEMPLATE_CHARS} characters")

    def evaluate() -> Any:
        compiled = OracleTemplateEnvironment().compile_expression(
            expression, undefined_to_none=False
        )
        return compiled(**variables)

    try:
        return run_with_deadline(evaluate, timeout_seconds)
    except RenderError:
        raise
    except Exception as error:
        raise RenderError(describe_template_error(error)) from None
