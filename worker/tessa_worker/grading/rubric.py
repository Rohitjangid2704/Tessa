import hashlib

RUBRIC_VERSION = "judge-rubric.v1"

RUBRIC_TEXT = (
    "Judge only the candidate answer against the reference material. "
    "Return pass only when every gold point that applies to the question is stated correctly or "
    "is consistent with the answer, no must-not-claim item is asserted, no invariant is "
    "violated, and every concrete claim in the answer is supported by the gold points or by "
    "the question itself. "
    "Return fail when the answer contradicts a gold point, asserts a must-not-claim item, "
    "violates an invariant or states a concrete claim that the reference material contradicts. "
    "Return uncertain when the reference material is too thin to decide, when the answer is "
    "empty or off topic, or when you are not sure. Never guess a pass."
)

CUSTOM_RUBRIC_PREFIX = "rubric-sha256:"
CUSTOM_RUBRIC_DIGEST_LENGTH = 12


def rubric_version_of(rubric_text: str) -> str:
    if rubric_text == RUBRIC_TEXT:
        return RUBRIC_VERSION
    digest = hashlib.sha256(rubric_text.encode()).hexdigest()
    return f"{CUSTOM_RUBRIC_PREFIX}{digest[:CUSTOM_RUBRIC_DIGEST_LENGTH]}"
