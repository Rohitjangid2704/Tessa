import ast
import logging
import re
from dataclasses import dataclass, field

import sqlglot
from sqlglot import exp
from sqlglot.dialects.dialect import Dialect
from sqlglot.errors import ErrorLevel, SqlglotError

DIALECT_ALIASES = {"postgresql": "postgres", "pg": "postgres"}
FORBIDDEN_FUNCTION_PATTERN = re.compile(
    r"^(?:"
    r"pg_read_.*|pg_ls_.*|pg_stat_file|pg_file_.*|pg_sleep.*|pg_logical_.*|pg_advisory_.*"
    r"|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile"
    r"|pg_create_.*|pg_drop_.*|pg_switch_.*|pg_promote|pg_backup_.*"
    r"|lo_.*|dblink.*|postgres_fdw.*|set_config|nextval|setval|currval"
    r"|query_to_xml.*|table_to_xml.*|cursor_to_xml.*|database_to_xml.*|schema_to_xml.*"
    r"|xp_.*|sp_.*|openrowset|opendatasource|openquery|load_file|sys_exec|sys_eval"
    r"|utl_.*|dbms_.*|read_csv.*|read_parquet|read_json.*|read_text|read_blob|read_ndjson.*"
    r"|http_.*|httpfs.*|copy_to|system|shell_exec|exec|execute|extractvalue_file"
    r")$"
)
FORBIDDEN_STATEMENT_NAMES = (
    "Insert",
    "Update",
    "Delete",
    "Merge",
    "Create",
    "Drop",
    "Alter",
    "AlterRename",
    "Copy",
    "Command",
    "TruncateTable",
    "Grant",
    "Revoke",
    "Set",
    "Use",
    "Transaction",
    "Commit",
    "Rollback",
    "LoadData",
    "Pragma",
    "Analyze",
    "Kill",
    "Refresh",
    "Attach",
    "Detach",
    "Declare",
    "Show",
    "Describe",
    "Cache",
    "Uncache",
    "Comment",
    "Export",
    "Install",
    "Put",
    "Get",
    "Execute",
    "ExecuteSql",
    "Cluster",
    "ToFile",
    "ReadCSV",
    "ReadParquet",
)
FORBIDDEN_STATEMENTS = tuple(
    node for name in FORBIDDEN_STATEMENT_NAMES if (node := getattr(exp, name, None)) is not None
)
ALLOWED_ROOTS: tuple[type[exp.Expr], ...] = (exp.Select, exp.SetOperation, exp.Subquery)
SQLGLOT_LOGGER = logging.getLogger("sqlglot")
SQLGLOT_LOGGER.setLevel(logging.ERROR)
SQL_LANGUAGE = "sql"
PYTHON_LANGUAGE = "python"
PYTHON_ENTRY_POINT = "run"
PYTHON_ENTRY_ARGUMENTS = 2


@dataclass(frozen=True)
class OracleProblem:
    code: str
    message: str
    line: int | None = None


@dataclass
class OracleLint:
    problems: list[OracleProblem] = field(default_factory=list)
    parameters: frozenset[str] = frozenset()

    @property
    def ok(self) -> bool:
        return not self.problems


def resolve_dialect(name: str | None) -> str | None:
    if not name:
        return None
    candidate = DIALECT_ALIASES.get(name.strip().lower(), name.strip().lower())
    if not candidate or Dialect.get(candidate) is None:
        return None
    return candidate


def parse_failure_line(error: SqlglotError) -> int | None:
    details = getattr(error, "errors", None)
    if isinstance(details, list) and details and isinstance(details[0], dict):
        line = details[0].get("line")
        return line if isinstance(line, int) else None
    return None


def describe(node: exp.Expr) -> str:
    return type(node).__name__.upper()


def function_names(tree: exp.Expr) -> list[str]:
    names: list[str] = []
    for node in tree.find_all(exp.Func):
        if isinstance(node, exp.Anonymous):
            names.append(node.name.lower())
        else:
            names.append(node.sql_name().lower())
    return names


def forbidden_node_problems(tree: exp.Expr) -> list[OracleProblem]:
    problems: list[OracleProblem] = []
    for node in tree.walk():
        if isinstance(node, FORBIDDEN_STATEMENTS):
            problems.append(
                OracleProblem(
                    "oracle_not_read_only",
                    f"{describe(node)} is not allowed in an oracle; only SELECT and WITH ... "
                    "SELECT queries are",
                )
            )
        elif isinstance(node, exp.Into):
            problems.append(
                OracleProblem(
                    "oracle_select_into", "SELECT ... INTO writes a table and is not allowed"
                )
            )
        elif isinstance(node, exp.Lock):
            problems.append(
                OracleProblem(
                    "oracle_row_lock", "FOR UPDATE and FOR SHARE take locks and are not allowed"
                )
            )
    return problems


def forbidden_function_problems(tree: exp.Expr) -> list[OracleProblem]:
    return [
        OracleProblem(
            "oracle_forbidden_function",
            f"Function {name}() reads files, reaches the network or changes state and is not "
            "allowed in an oracle",
        )
        for name in dict.fromkeys(function_names(tree))
        if FORBIDDEN_FUNCTION_PATTERN.match(name)
    ]


def root_problem(statement: exp.Expr) -> OracleProblem | None:
    if not isinstance(statement, ALLOWED_ROOTS):
        return OracleProblem(
            "oracle_not_a_select",
            f"The statement is a {describe(statement)}; only SELECT and WITH ... SELECT are "
            "allowed",
        )
    if isinstance(statement, exp.Subquery) and not isinstance(
        statement.unnest(), (exp.Select, exp.SetOperation)
    ):
        return OracleProblem("oracle_not_a_select", "The parenthesised statement is not a SELECT")
    return None


def placeholder_names(tree: exp.Expr) -> frozenset[str]:
    return frozenset(
        str(node.this) for node in tree.find_all(exp.Placeholder) if isinstance(node.this, str)
    )


def lint_sql_oracle(sql: str, dialect_name: str | None) -> OracleLint:
    dialect = resolve_dialect(dialect_name)
    if dialect is None:
        shown = dialect_name if dialect_name else "none declared"
        return OracleLint(
            [
                OracleProblem(
                    "oracle_dialect_unknown",
                    f"The SQL dialect of the truth source is unknown ({shown}); declare a dialect "
                    "such as postgres, mysql or sqlite so the query can be checked",
                )
            ]
        )
    try:
        statements = sqlglot.parse(sql, read=dialect, error_level=ErrorLevel.RAISE)
    except SqlglotError as error:
        return OracleLint(
            [
                OracleProblem(
                    "oracle_sql_unparseable",
                    f"The query does not parse as {dialect} SQL: "
                    f"{str(error).splitlines()[0][:200]}",
                    parse_failure_line(error),
                )
            ]
        )
    except RecursionError:
        return OracleLint(
            [OracleProblem("oracle_sql_unparseable", "The query is nested too deeply")]
        )
    present = [statement for statement in statements if statement is not None]
    if not present:
        return OracleLint([OracleProblem("oracle_sql_empty", "The file holds no SQL statement")])
    if len(present) > 1:
        return OracleLint(
            [
                OracleProblem(
                    "oracle_multiple_statements",
                    f"The file holds {len(present)} statements; an oracle is exactly one SELECT",
                )
            ]
        )
    statement = present[0]
    problems: list[OracleProblem] = []
    root = root_problem(statement)
    if root is not None:
        problems.append(root)
    problems.extend(forbidden_node_problems(statement))
    problems.extend(forbidden_function_problems(statement))
    unique: list[OracleProblem] = []
    seen: set[tuple[str, str]] = set()
    for problem in problems:
        if (problem.code, problem.message) not in seen:
            seen.add((problem.code, problem.message))
            unique.append(problem)
    return OracleLint(unique, placeholder_names(statement))


def find_entry_point(module: ast.Module) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
    for node in module.body:
        if (
            isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
            and node.name == PYTHON_ENTRY_POINT
        ):
            return node
    return None


def lint_python_oracle(source: str) -> OracleLint:
    try:
        module = ast.parse(source)
    except SyntaxError as error:
        return OracleLint(
            [
                OracleProblem(
                    "oracle_python_syntax", f"The file does not parse: {error.msg}", error.lineno
                )
            ]
        )
    except (ValueError, RecursionError, MemoryError) as error:
        return OracleLint(
            [OracleProblem("oracle_python_syntax", f"The file does not parse: {error}")]
        )
    entry_point = find_entry_point(module)
    if entry_point is None:
        return OracleLint(
            [
                OracleProblem(
                    "oracle_python_no_run",
                    "The file does not define run(params, connect) at the top level",
                )
            ]
        )
    arguments = entry_point.args
    positional = [*arguments.posonlyargs, *arguments.args]
    required = len(positional) - len(arguments.defaults)
    accepts_two = len(positional) >= PYTHON_ENTRY_ARGUMENTS or arguments.vararg is not None
    if not accepts_two or required > PYTHON_ENTRY_ARGUMENTS:
        return OracleLint(
            [
                OracleProblem(
                    "oracle_python_bad_signature",
                    "run must accept exactly the two arguments (params, connect)",
                    entry_point.lineno,
                )
            ]
        )
    return OracleLint()
