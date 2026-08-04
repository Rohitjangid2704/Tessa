from enum import StrEnum
from typing import Any

from sqlalchemy import Dialect, Text
from sqlalchemy.types import TypeDecorator


class StrEnumType[E: StrEnum](TypeDecorator[E]):
    impl = Text
    cache_ok = True

    def __init__(self, enum_class: type[E]) -> None:
        super().__init__()
        self.enum_class = enum_class

    def process_bind_param(self, value: E | None, dialect: Dialect) -> str | None:
        if value is None:
            return None
        return self.enum_class(value).value

    def process_result_value(self, value: Any, dialect: Dialect) -> E | None:
        if value is None:
            return None
        return self.enum_class(value)
