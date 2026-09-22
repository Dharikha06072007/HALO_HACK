from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

try:
    from pymongo import ASCENDING, MongoClient
    from pymongo.errors import DuplicateKeyError, PyMongoError
except ImportError:  # pragma: no cover
    ASCENDING = None
    MongoClient = None
    DuplicateKeyError = Exception
    PyMongoError = Exception


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class MongoStore:
    def __init__(self) -> None:
        self.client = None
        self.db = None
        self.available = False
        uri = os.getenv("MONGODB_URI", "").strip()
        if uri and MongoClient:
            try:
                self.client = MongoClient(uri, serverSelectionTimeoutMS=800)
                self.client.admin.command("ping")
                self.db = self.client[os.getenv("MONGODB_DB_NAME", "skillsync_ai")]
                self._create_indexes()
                self.available = True
            except PyMongoError:
                self.close()

    def _create_indexes(self) -> None:
        if self.db is None:
            return
        self.db.interview_answers.create_index("answer_submission_id", unique=True)
        for collection, fields in {
            "resumes": [("user_id", ASCENDING), ("created_at", ASCENDING)],
            "job_descriptions": [("user_id", ASCENDING), ("created_at", ASCENDING)],
            "resume_analyses": [("resume_id", ASCENDING), ("job_description_id", ASCENDING), ("created_at", ASCENDING)],
            "learning_paths": [("analysis_id", ASCENDING), ("created_at", ASCENDING)],
            "interview_sessions": [("analysis_id", ASCENDING), ("created_at", ASCENDING)],
            "interview_questions": [("session_id", ASCENDING), ("created_at", ASCENDING)],
            "interview_answers": [("session_id", ASCENDING), ("created_at", ASCENDING)],
            "interview_feedback": [("session_id", ASCENDING), ("created_at", ASCENDING)],
        }.items():
            for field in fields:
                self.db[collection].create_index(field)

    def close(self) -> None:
        if self.client:
            self.client.close()
        self.client = None
        self.db = None
        self.available = False

    def insert(self, collection: str, document: dict[str, Any]) -> str | None:
        if not self.available or self.db is None:
            return None
        document.setdefault("created_at", utc_now())
        try:
            result = self.db[collection].insert_one(document)
            return str(result.inserted_id)
        except DuplicateKeyError:
            return None

    def find_one(self, collection: str, query: dict[str, Any]) -> dict[str, Any] | None:
        if not self.available or self.db is None:
            return None
        result = self.db[collection].find_one(query)
        if result and "_id" in result:
            result["_id"] = str(result["_id"])
        return result

    def update(self, collection: str, query: dict[str, Any], values: dict[str, Any]) -> None:
        if self.available and self.db is not None:
            self.db[collection].update_one(query, {"$set": values})

    def duplicate(self, error: Exception) -> bool:
        return isinstance(error, DuplicateKeyError)


store = MongoStore()
