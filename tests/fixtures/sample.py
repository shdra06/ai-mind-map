"""
Sample Python fixture for testing the parser.
Contains functions, classes, and methods.
"""

import os
from pathlib import Path


def greet(name: str) -> str:
    """Return a greeting string."""
    return f"Hello, {name}!"


async def fetch_data(url: str, timeout: int = 30) -> str:
    """Fetch data from a URL."""
    return ""


class UserRepository:
    """A repository for managing users."""

    def __init__(self, db_path: str):
        """Initialize the repository."""
        self.db_path = db_path
        self._users = {}

    def create_user(self, name: str, email: str) -> dict:
        """Create a new user."""
        user = {"name": name, "email": email}
        self._users[name] = user
        return user

    def get_user(self, name: str) -> dict | None:
        """Get a user by name."""
        return self._users.get(name)

    def _internal_method(self):
        """A protected method."""
        pass

    def __private_method(self):
        """A private method."""
        pass

    @staticmethod
    def from_json(data: str) -> "UserRepository":
        """Create from JSON."""
        return UserRepository("")


class AdminRepository(UserRepository):
    """Extended repository for admins."""

    def list_admins(self) -> list:
        """List all admins."""
        return []


API_VERSION = "1.0.0"
