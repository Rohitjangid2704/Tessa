import copy
import hashlib
import json

Row = dict[str, str | int]

SEED_ROOMS: list[Row] = [
    {"number": "20001", "status": "CLEAN", "floor": 2},
    {"number": "20002", "status": "DIRTY", "floor": 2},
    {"number": "20003", "status": "DIRTY", "floor": 2},
    {"number": "20004", "status": "OCCUPIED", "floor": 2},
    {"number": "20005", "status": "DIRTY", "floor": 2},
    {"number": "30001", "status": "CLEAN", "floor": 3},
    {"number": "30002", "status": "OCCUPIED", "floor": 3},
    {"number": "30003", "status": "CLEAN", "floor": 3},
]

SEED_ISSUES: list[Row] = [
    {"id": "1", "room": "20003", "title": "Shower leaks", "status": "OPEN"},
    {"id": "2", "room": "20003", "title": "Lamp is broken", "status": "OPEN"},
    {"id": "3", "room": "30002", "title": "Air conditioning is noisy", "status": "OPEN"},
    {"id": "4", "room": "20001", "title": "Door lock sticks", "status": "RESOLVED"},
    {"id": "5", "room": "30001", "title": "Window will not close", "status": "RESOLVED"},
]


class Dataset:
    def __init__(self) -> None:
        self.rooms: list[Row] = []
        self.issues: list[Row] = []
        self.next_issue_id = 0
        self.reset()

    def reset(self) -> None:
        self.rooms = copy.deepcopy(SEED_ROOMS)
        self.issues = copy.deepcopy(SEED_ISSUES)
        self.next_issue_id = len(self.issues) + 1

    def list_rooms(self, status: str | None) -> list[Row]:
        return [room for room in self.rooms if status is None or room["status"] == status]

    def list_issues(self, status: str | None) -> list[Row]:
        return [issue for issue in self.issues if status is None or issue["status"] == status]

    def create_issue(self, room: str, title: str) -> Row:
        issue: Row = {
            "id": str(self.next_issue_id),
            "room": room,
            "title": title,
            "status": "OPEN",
        }
        self.next_issue_id += 1
        self.issues.append(issue)
        return issue

    def resolve_issue(self, issue_id: str) -> Row | None:
        for issue in self.issues:
            if issue["id"] == issue_id:
                issue["status"] = "RESOLVED"
                return issue
        return None

    def state_hash(self) -> str:
        document = json.dumps({"rooms": self.rooms, "issues": self.issues}, sort_keys=True)
        return hashlib.sha256(document.encode("utf-8")).hexdigest()[:32]
