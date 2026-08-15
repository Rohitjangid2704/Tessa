from enum import StrEnum


class OracleFailureCode(StrEnum):
    unsupported_dialect = "unsupported_dialect"
    unsupported_source = "unsupported_source"
    not_read_only = "not_read_only"
    sql_invalid = "sql_invalid"
    parameter_missing = "parameter_missing"
    parameter_invalid = "parameter_invalid"
    environment_missing = "environment_missing"
    connection_failed = "connection_failed"
    query_failed = "query_failed"
    read_only_violation = "read_only_violation"
    timeout = "timeout"
    output_too_large = "output_too_large"
    process_failed = "process_failed"
    render_failed = "render_failed"
    not_found = "not_found"


class OracleExecutionError(Exception):
    def __init__(self, code: OracleFailureCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
