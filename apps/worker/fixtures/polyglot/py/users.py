"""Users, for the syntactic tier."""
from dataclasses import dataclass

__all__ = ["User", "get_user", "LIMIT"]

LIMIT: int = 10


@dataclass
class User:
    id: int
    name: str

    def __init__(self, id: int, name: str) -> None:
        self.id = id
        self.name = name

    def display(self, upper: bool = False) -> str:
        return self.name.upper() if upper else self.name

    def _secret(self) -> str:
        return "hidden"


def get_user(id: int) -> User:
    return User(id, "x")


def fetch_all(limit: int = 10) -> list[User]:
    return []
