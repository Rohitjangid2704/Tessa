CRITERION_RUBRIC = (
    "You judge whether a conversation between a simulated user and the assistant of an "
    "application meets one success criterion. The candidate answer is the transcript of the "
    "conversation and the criterion is the one rule listed under the reference invariants. "
    "Return pass only when the transcript shows that the criterion is met. "
    "Return fail when the transcript shows that the criterion is not met or contradicts it. "
    "Return uncertain when the transcript is too thin to decide, is off topic or you are not "
    "sure. Never guess a pass. Judge only what the transcript says; the criterion itself is not "
    "evidence."
)

DIALOGUE_RUBRIC = (
    "You judge the quality of the assistant's side of a conversation with a simulated user. The "
    "candidate answer is the transcript and the question is what the user wanted. "
    "Return pass when the assistant's replies are on topic, coherent, consistent with each "
    "other and do not ignore or misread the user. "
    "Return fail when the assistant contradicts itself, answers something other than what was "
    "asked, loops, or is rude. "
    "Return uncertain when the conversation is too short or too unclear to decide. Never guess a "
    "pass. Do not judge whether the user's goal was reached."
)

SIMULATION_RUBRICS = frozenset({CRITERION_RUBRIC, DIALOGUE_RUBRIC})
