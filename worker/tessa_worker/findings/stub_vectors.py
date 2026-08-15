import hashlib
import math
import re
from collections.abc import Sequence

TOKEN_PATTERN = re.compile(r"[a-z0-9_<>]+")
EMPTY_TEXT_TOKEN = "<empty>"
INDEX_BYTES = 4
VECTOR_DIGITS = 6


def text_tokens(text: str) -> list[str]:
    return TOKEN_PATTERN.findall(text.lower()) or [EMPTY_TEXT_TOKEN]


def signed_slot(token: str, dimensions: int) -> tuple[int, float]:
    digest = hashlib.sha256(token.encode("utf-8")).digest()
    index = int.from_bytes(digest[:INDEX_BYTES], "big") % dimensions
    sign = 1.0 if digest[INDEX_BYTES] & 1 else -1.0
    return index, sign


def stub_vector(text: str, dimensions: int) -> list[float]:
    weights: dict[int, float] = {}
    for token in text_tokens(text):
        index, sign = signed_slot(token, dimensions)
        weights[index] = weights.get(index, 0.0) + sign
    norm = math.sqrt(sum(weight * weight for weight in weights.values()))
    vector = [0.0] * dimensions
    if norm == 0.0:
        vector[signed_slot(EMPTY_TEXT_TOKEN, dimensions)[0]] = 1.0
        return vector
    for index, weight in weights.items():
        vector[index] = round(weight / norm, VECTOR_DIGITS)
    return vector


def stub_vectors(texts: Sequence[str], dimensions: int) -> list[list[float]]:
    return [stub_vector(text, dimensions) for text in texts]
