from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any


def generate_json(prompt: str, fallback: dict[str, Any]) -> dict[str, Any]:
    """Call Gemini only on the server; return deterministic data when unavailable."""
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if os.getenv("DEMO_MODE", "true").lower() == "true" or not api_key:
        return fallback
    payload = json.dumps({"contents": [{"parts": [{"text": prompt}]}]}).encode("utf-8")
    request = urllib.request.Request(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + api_key,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            data = json.loads(response.read().decode("utf-8"))
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        text = text[text.find("{") : text.rfind("}") + 1]
        return json.loads(text)
    except (urllib.error.URLError, KeyError, IndexError, ValueError, TimeoutError):
        return fallback
