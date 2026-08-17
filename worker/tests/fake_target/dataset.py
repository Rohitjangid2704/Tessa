import hashlib
import json
from dataclasses import dataclass, field

STAFF_EMAIL = "staff@fake.test"
STAFF_PASSWORD = "dev-only-fake-staff-password"
MANAGER_TOKEN = "dev-only-fake-manager-token-0123456789"
ADMIN_TOKEN = "dev-only-fake-admin-token-0123456789"
SESSION_COOKIE = "fake_session"

ROLES = ("staff", "manager", "admin")
STATIC_TOKENS = {MANAGER_TOKEN: "manager", ADMIN_TOKEN: "admin"}
USERS = (
    {"email": STAFF_EMAIL, "role": "staff"},
    {"email": "manager@fake.test", "role": "manager"},
    {"email": "admin@fake.test", "role": "admin"},
)

SEED_ROOMS = (
    ("20001", "clean", 2),
    ("20002", "dirty", 2),
    ("20003", "dirty", 2),
    ("20004", "clean", 2),
    ("20005", "dirty", 3),
    ("20006", "clean", 3),
    ("20007", "clean", 3),
    ("20008", "clean", 3),
)
SEED_ISSUES = (
    (9101, "20003", "shower leaks", "open"),
    (9102, "20003", "light flickers", "open"),
    (9103, "20005", "tv remote missing", "open"),
    (9104, "20001", "door sticks", "closed"),
    (9105, "20007", "air conditioning is noisy", "closed"),
)
FIRST_NEW_ISSUE_ID = 9200


@dataclass(frozen=True)
class Room:
    number: str
    status: str
    floor: int


@dataclass
class Issue:
    id: int
    room: str
    description: str
    status: str


@dataclass
class Dataset:
    rooms: list[Room] = field(default_factory=list)
    issues: list[Issue] = field(default_factory=list)
    next_issue_id: int = FIRST_NEW_ISSUE_ID

    def reset(self) -> None:
        self.rooms = [Room(*row) for row in SEED_ROOMS]
        self.issues = [Issue(*row) for row in SEED_ISSUES]
        self.next_issue_id = FIRST_NEW_ISSUE_ID

    def rooms_with(self, status: str | None) -> list[Room]:
        return [room for room in self.rooms if status is None or room.status == status]

    def issues_with(self, status: str | None) -> list[Issue]:
        return [issue for issue in self.issues if status is None or issue.status == status]

    def open_issues_per_room(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for issue in self.issues_with("open"):
            counts[issue.room] = counts.get(issue.room, 0) + 1
        return dict(sorted(counts.items(), key=lambda item: (-item[1], item[0])))

    def add_issue(self, room: str, description: str) -> Issue:
        issue = Issue(self.next_issue_id, room, description, "open")
        self.next_issue_id += 1
        self.issues.append(issue)
        return issue

    def has_room(self, number: str) -> bool:
        return any(room.number == number for room in self.rooms)

    def state_hash(self) -> str:
        state = {
            "rooms": [[room.number, room.status] for room in self.rooms],
            "issues": [
                [issue.id, issue.room, issue.description, issue.status] for issue in self.issues
            ],
        }
        return hashlib.sha256(json.dumps(state, sort_keys=True).encode()).hexdigest()[:32]


def seeded_dataset() -> Dataset:
    dataset = Dataset()
    dataset.reset()
    return dataset
