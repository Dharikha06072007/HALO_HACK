from __future__ import annotations

import os
import uuid
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


class Store:
    def __init__(self) -> None:
        self.client = None
        self.db = None
        self.memory: dict[str, dict[str, dict[str, Any]]] = {}
        self.available = False
        uri = os.getenv("MONGODB_URI", "").strip()
        if uri and MongoClient:
            try:
                self.client = MongoClient(uri, serverSelectionTimeoutMS=800)
                self.client.admin.command("ping")
                self.db = self.client[os.getenv("MONGODB_DB_NAME", "skillsync_ai")]
                self._indexes()
                self.available = True
            except PyMongoError:
                self.close()

    def _indexes(self) -> None:
        if self.db is None:
            return
        self.db.users.create_index("email", unique=True)
        self.db.interview_answers.create_index("answer_submission_id", unique=True)
        for collection in ("resumes", "job_descriptions", "resume_analyses", "learning_paths", "interview_sessions", "interview_questions", "interview_answers", "interview_feedback"):
            self.db[collection].create_index([("user_id", ASCENDING), ("created_at", ASCENDING)])

    def close(self) -> None:
        if self.client:
            self.client.close()
        self.client = None
        self.db = None
        self.available = False

    def insert(self, collection: str, document: dict[str, Any]) -> str:
        document = {**document}
        document.setdefault("_id", str(uuid.uuid4()))
        document.setdefault("created_at", utc_now())
        if self.available and self.db is not None:
            try:
                result = self.db[collection].insert_one(document)
                return str(result.inserted_id)
            except DuplicateKeyError:
                raise
        self.memory.setdefault(collection, {})[str(document["_id"])] = document
        return str(document["_id"])

    def find_one(self, collection: str, query: dict[str, Any]) -> dict[str, Any] | None:
        if self.available and self.db is not None:
            result = self.db[collection].find_one(query)
            if result and "_id" in result:
                result["_id"] = str(result["_id"])
            return result
        for document in self.memory.get(collection, {}).values():
            if all(document.get(key) == value for key, value in query.items()):
                return dict(document)
        return None

    def find_many(self, collection: str, query: dict[str, Any]) -> list[dict[str, Any]]:
        if self.available and self.db is not None:
            cursor = self.db[collection].find(query).sort("created_at", -1)
            return [{**item, "_id": str(item["_id"])} for item in cursor]
        return [dict(item) for item in self.memory.get(collection, {}).values() if all(item.get(key) == value for key, value in query.items())]

    def update(self, collection: str, query: dict[str, Any], values: dict[str, Any]) -> None:
        if self.available and self.db is not None:
            self.db[collection].update_one(query, {"$set": values})
            return
        document = self.find_one(collection, query)
        if document:
            document.update(values)
            self.memory[collection][str(document["_id"])] = document


store = Store()
