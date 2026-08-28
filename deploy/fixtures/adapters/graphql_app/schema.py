from dataclasses import dataclass
from typing import Any

from graphql import GraphQLError, GraphQLResolveInfo, GraphQLSchema, build_schema

from fixtures.adapters.graphql_app.config import MUTATING_ROLES
from fixtures.adapters.graphql_app.store import Dataset, Row

SDL = """
enum RoomStatus {
  CLEAN
  DIRTY
  OCCUPIED
}

enum IssueStatus {
  OPEN
  RESOLVED
}

type Room {
  number: String!
  status: RoomStatus!
  floor: Int!
}

type Issue {
  id: ID!
  room: String!
  title: String!
  status: IssueStatus!
}

input CreateIssueInput {
  room: String!
  title: String!
}

type Query {
  rooms(status: RoomStatus): [Room!]!
  issues(status: IssueStatus): [Issue!]!
  viewer: String!
}

type Mutation {
  createIssue(input: CreateIssueInput!): Issue!
  resolveIssue(id: ID!): Issue!
}
"""


@dataclass(frozen=True)
class RequestContext:
    role: str


def build_fixture_schema() -> GraphQLSchema:
    return build_schema(SDL)


def forbidden() -> GraphQLError:
    return GraphQLError("not authorized", extensions={"code": "FORBIDDEN"})


def require_mutation_role(info: GraphQLResolveInfo) -> None:
    context = info.context
    if not isinstance(context, RequestContext) or context.role not in MUTATING_ROLES:
        raise forbidden()


def build_root_value(dataset: Dataset) -> dict[str, Any]:
    def rooms(_info: GraphQLResolveInfo, status: str | None = None) -> list[Row]:
        return dataset.list_rooms(status)

    def issues(_info: GraphQLResolveInfo, status: str | None = None) -> list[Row]:
        return dataset.list_issues(status)

    def viewer(info: GraphQLResolveInfo) -> str:
        context = info.context
        return context.role if isinstance(context, RequestContext) else "anonymous"

    def create_issue(info: GraphQLResolveInfo, input: dict[str, str]) -> Row:
        require_mutation_role(info)
        return dataset.create_issue(input["room"], input["title"])

    def resolve_issue(info: GraphQLResolveInfo, id: str) -> Row:
        require_mutation_role(info)
        resolved = dataset.resolve_issue(id)
        if resolved is None:
            raise GraphQLError("issue not found", extensions={"code": "NOT_FOUND"})
        return resolved

    return {
        "rooms": rooms,
        "issues": issues,
        "viewer": viewer,
        "createIssue": create_issue,
        "resolveIssue": resolve_issue,
    }
