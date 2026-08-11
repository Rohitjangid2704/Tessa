import pytest

from tessa_api.services.oracle_lint import (
    lint_python_oracle,
    lint_sql_oracle,
    resolve_dialect,
)

OPEN_MAINTENANCE = """
WITH open_issues AS (
    SELECT room_id, count(*) AS n
    FROM smart_log_issue
    WHERE property_id = :tenant_id AND status = 'open' AND created_at < :today
    GROUP BY room_id
)
SELECT r.room_number AS room, o.n AS open_issues
FROM open_issues o JOIN room r ON r.id = o.room_id
ORDER BY o.n DESC, r.room_number
"""


def codes(sql: str, dialect: str | None = "postgres") -> list[str]:
    return sorted({problem.code for problem in lint_sql_oracle(sql, dialect).problems})


def test_real_oracle_query_is_accepted_and_parameters_are_found() -> None:
    lint = lint_sql_oracle(OPEN_MAINTENANCE, "postgres")
    assert lint.ok
    assert lint.parameters == {"tenant_id", "today"}


@pytest.mark.parametrize(
    "sql",
    [
        "select 1",
        "SELECT 1;",
        "with a as (select 1 as x) select * from a",
        "(select 1) union all (select 2)",
        "select 1 union select 2 except select 3",
        "select x::text, extract(epoch from now()), replace(name, 'a', 'b') from t",
        "select * from t where id in (select id from u) and exists (select 1 from v)",
        "select * from generate_series(1, 10) as g",
        "select max(x) over (partition by y order by z) from t",
        'select s."set", "comment" from t',
        "select pg_typeof(1), current_setting('timezone'), version()",
        "select count(*) filter (where a) from t limit 10 offset 5",
    ],
)
def test_select_queries_are_accepted(sql: str) -> None:
    assert lint_sql_oracle(sql, "postgres").problems == []


@pytest.mark.parametrize(
    ("sql", "expected"),
    [
        ("select 1; drop table x", "oracle_multiple_statements"),
        ("select 1; select 2", "oracle_multiple_statements"),
        ("drop table x", "oracle_not_read_only"),
        ("insert into x values (1)", "oracle_not_read_only"),
        ("update x set a = 1", "oracle_not_read_only"),
        ("delete from x", "oracle_not_read_only"),
        ("truncate x", "oracle_not_read_only"),
        ("create table t as select 1", "oracle_not_read_only"),
        ("alter table t add column a int", "oracle_not_read_only"),
        ("grant all on t to someone", "oracle_not_read_only"),
        ("copy t to '/tmp/x'", "oracle_not_read_only"),
        ("explain select 1", "oracle_not_read_only"),
        ("show all", "oracle_not_read_only"),
        ("set role admin", "oracle_not_read_only"),
        ("call p()", "oracle_not_read_only"),
        (
            "with t as (insert into x values (1) returning *) select * from t",
            "oracle_not_read_only",
        ),
        ("with t as (delete from x returning *) select * from t", "oracle_not_read_only"),
        ("with t as (update x set a = 1 returning *) select * from t", "oracle_not_read_only"),
        ("select * into newt from t", "oracle_select_into"),
        ("select * from t for update", "oracle_row_lock"),
        ("select * from t for share", "oracle_row_lock"),
        ("select * from t for no key update", "oracle_row_lock"),
        ("select pg_read_file('/etc/passwd')", "oracle_forbidden_function"),
        ("select pg_catalog.pg_read_file('/etc/passwd')", "oracle_forbidden_function"),
        ("select \"pg_read_file\"('/etc/passwd')", "oracle_forbidden_function"),
        ("select pg_read_binary_file('/etc/passwd')", "oracle_forbidden_function"),
        ("select pg_ls_dir('.')", "oracle_forbidden_function"),
        ("select * from dblink('host=x', 'select 1') as t(a int)", "oracle_forbidden_function"),
        ("select dblink_exec('host=x', 'delete from y')", "oracle_forbidden_function"),
        ("select lo_import('/etc/passwd')", "oracle_forbidden_function"),
        ("select pg_sleep(30)", "oracle_forbidden_function"),
        ("select set_config('a', 'b', false)", "oracle_forbidden_function"),
        ("select nextval('seq')", "oracle_forbidden_function"),
        ("select query_to_xml('delete from x', true, true, '')", "oracle_forbidden_function"),
        ("select 1 from t where x = (select pg_read_file('/x'))", "oracle_forbidden_function"),
        ("select * from t union select pg_ls_dir('.')", "oracle_forbidden_function"),
        ("select * from read_csv('/data.csv')", "oracle_forbidden_function"),
        ("values (1)", "oracle_not_a_select"),
        ("table t", "oracle_not_a_select"),
        ("", "oracle_sql_empty"),
        (";", "oracle_sql_empty"),
        ("-- only a comment", "oracle_sql_empty"),
        ("select (", "oracle_sql_unparseable"),
        ("select * from", "oracle_sql_unparseable"),
    ],
)
def test_adversarial_sql_is_rejected(sql: str, expected: str) -> None:
    assert expected in codes(sql)


def test_unparseable_sql_reports_a_line() -> None:
    problem = lint_sql_oracle("select 1\nfrom\nwhere )", "postgres").problems[0]
    assert problem.code == "oracle_sql_unparseable"


@pytest.mark.parametrize("dialect", [None, "", "nonsense", "oracle-ish", "  "])
def test_unknown_dialect_fails_closed(dialect: str | None) -> None:
    assert codes("select 1", dialect) == ["oracle_dialect_unknown"]


@pytest.mark.parametrize(
    "name", ["postgres", "PostgreSQL", "postgresql", "mysql", "sqlite", "tsql"]
)
def test_known_dialects_are_resolved(name: str) -> None:
    assert resolve_dialect(name) is not None
    assert lint_sql_oracle("select 1", name).ok


def test_dialect_aliases_resolve_to_the_sqlglot_name() -> None:
    assert resolve_dialect("postgresql") == "postgres"
    assert resolve_dialect("nonsense") is None
    assert resolve_dialect(None) is None


def test_mysql_outfile_is_rejected() -> None:
    assert not lint_sql_oracle("select * from t into outfile '/tmp/x'", "mysql").ok


GOOD_PYTHON = """
def helper(rows):
    return rows


def run(params, connect):
    with connect() as connection:
        return [{"n": 1}]
"""


def test_python_oracle_with_run_is_accepted() -> None:
    assert lint_python_oracle(GOOD_PYTHON).ok


@pytest.mark.parametrize(
    "source",
    [
        "async def run(params, connect):\n    return []\n",
        "def run(p, c):\n    return []\n",
        "def run(params, connect, extra=None):\n    return []\n",
        "def run(*args):\n    return []\n",
    ],
)
def test_python_oracle_signature_variants_are_accepted(source: str) -> None:
    assert lint_python_oracle(source).ok


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("def run(params, connect:\n    pass\n", "oracle_python_syntax"),
        ("x = 1\n", "oracle_python_no_run"),
        ("class A:\n    def run(self, params, connect):\n        pass\n", "oracle_python_no_run"),
        ("def run(params):\n    return []\n", "oracle_python_bad_signature"),
        ("def run(a, b, c):\n    return []\n", "oracle_python_bad_signature"),
        ("def run():\n    return []\n", "oracle_python_bad_signature"),
    ],
)
def test_broken_python_oracles_are_rejected(source: str, expected: str) -> None:
    problems = lint_python_oracle(source).problems
    assert [problem.code for problem in problems] == [expected]


def test_python_syntax_error_carries_a_line_number() -> None:
    problem = lint_python_oracle("x = 1\ndef run(params, connect:\n    pass\n").problems[0]
    assert problem.line is not None
