from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from typing import Any, BinaryIO

try:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError
except ImportError:  # pragma: no cover
    boto3 = None
    BotoCoreError = ClientError = Exception

TABLES = {
    "users": "skillsync-users",
    "resumes": "skillsync-resumes",
    "job_descriptions": "skillsync-jobs",
    "resume_analyses": "skillsync-analyses",
    "learning_paths": "skillsync-learning-paths",
    "interview_sessions": "skillsync-interview-sessions",
    "interview_questions": "skillsync-interview-questions",
    "interview_answers": "skillsync-interview-answers",
    "interview_feedback": "skillsync-interview-feedback",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def serialize(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): serialize(item) for key, item in value.items()}
    if isinstance(value, list):
        return [serialize(item) for item in value]
    return value


class DuplicateKeyError(Exception):
    pass


class DynamoStore:
    def __init__(self) -> None:
        self.resource = None
        self.client = None
        self.tables: dict[str, Any] = {}
        self.memory: dict[str, dict[str, dict[str, Any]]] = {}
        self.available = False
        if not boto3:
            return
        try:
            kwargs = {"region_name": os.getenv("AWS_REGION", "us-east-1")}
            endpoint = os.getenv("DYNAMODB_ENDPOINT_URL", "").strip()
            if endpoint:
                kwargs["endpoint_url"] = endpoint
            self.resource = boto3.resource("dynamodb", **kwargs)
            self.client = boto3.client("dynamodb", **kwargs)
            if os.getenv("DYNAMODB_CREATE_TABLES", "false").lower() == "true":
                self._ensure_tables()
            self.available = all(self._table_exists(name) for name in TABLES.values())
            if self.available:
                self.tables = {name: self.resource.Table(table_name) for name, table_name in TABLES.items()}
        except (BotoCoreError, ClientError):
            self.close()

    def _table_exists(self, table_name: str) -> bool:
        try:
            self.client.describe_table(TableName=table_name)
            return True
        except (BotoCoreError, ClientError):
            return False

    def _ensure_tables(self) -> None:
        for table_name in TABLES.values():
            if self._table_exists(table_name):
                continue
            self.client.create_table(TableName=table_name, KeySchema=[{"AttributeName": "id", "KeyType": "HASH"}], AttributeDefinitions=[{"AttributeName": "id", "AttributeType": "S"}], BillingMode="PAY_PER_REQUEST")

    def close(self) -> None:
        self.resource = None
        self.client = None
        self.tables = {}
        self.available = False

    def insert(self, collection: str, document: dict[str, Any]) -> str:
        item = serialize({**document})
        item.setdefault("id", item.get("_id", str(uuid.uuid4())))
        item.setdefault("_id", item["id"])
        item.setdefault("created_at", utc_now())
        if self.available:
            try:
                self.tables[collection].put_item(Item=item, ConditionExpression="attribute_not_exists(id)")
                return str(item["id"])
            except ClientError as error:
                if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                    raise DuplicateKeyError from error
                raise
        self.memory.setdefault(collection, {})[str(item["id"])] = item
        return str(item["id"])

    def find_one(self, collection: str, query: dict[str, Any]) -> dict[str, Any] | None:
        normalized = {"id" if key in {"_id", "id"} else key: value for key, value in query.items()}
        if self.available:
            table = self.tables[collection]
            item = None
            if "id" in normalized:
                item = table.get_item(Key={"id": str(normalized["id"])}).get("Item")
            else:
                items = self.find_many(collection, normalized)
                item = items[0] if items else None
            if item and all(item.get(key) == value for key, value in normalized.items()):
                return item
            return None
        for item in self.memory.get(collection, {}).values():
            if all(item.get(key) == value for key, value in normalized.items()):
                return dict(item)
        return None

    def find_many(self, collection: str, query: dict[str, Any]) -> list[dict[str, Any]]:
        normalized = {"id" if key in {"_id", "id"} else key: value for key, value in query.items()}
        if self.available:
            scan_kwargs: dict[str, Any] = {}
            if normalized:
                from boto3.dynamodb.conditions import Attr
                expression = None
                for key, value in normalized.items():
                    condition = Attr(key).eq(value)
                    expression = condition if expression is None else expression & condition
                scan_kwargs["FilterExpression"] = expression
            items: list[dict[str, Any]] = []
            while True:
                response = self.tables[collection].scan(**scan_kwargs)
                items.extend(response.get("Items", []))
                if "LastEvaluatedKey" not in response:
                    break
                scan_kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]
            return sorted(items, key=lambda item: str(item.get("created_at", "")), reverse=True)
        return [dict(item) for item in self.memory.get(collection, {}).values() if all(item.get(key) == value for key, value in normalized.items())]

    def update(self, collection: str, query: dict[str, Any], values: dict[str, Any]) -> None:
        item = self.find_one(collection, query)
        if not item:
            return
        if self.available:
            from boto3.dynamodb.conditions import Attr
            update_parts = []
            names: dict[str, str] = {}
            attributes: dict[str, Any] = {}
            for index, (key, value) in enumerate(serialize(values).items()):
                alias = f"#field{index}"
                token = f":value{index}"
                names[alias] = key
                attributes[token] = value
                update_parts.append(f"{alias} = {token}")
            self.tables[collection].update_item(Key={"id": item["id"]}, UpdateExpression="SET " + ", ".join(update_parts), ExpressionAttributeNames=names, ExpressionAttributeValues=attributes)
            return
        item.update(serialize(values))
        self.memory[collection][str(item["id"])] = item

    def upload_file(self, file_obj: BinaryIO, key: str, content_type: str | None = None) -> str | None:
        bucket = os.getenv("S3_BUCKET_NAME", "").strip()
        if not bucket or not self.resource:
            return None
        extra = {"ContentType": content_type} if content_type else {}
        self.resource.meta.client.upload_fileobj(file_obj, bucket, key, ExtraArgs=extra)
        return f"s3://{bucket}/{key}"


store = DynamoStore()
