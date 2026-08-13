from tessa_api.schemas.enums import AdapterKind, SkipReason


class AdapterError(Exception):
    pass


class UnsupportedAdapterError(AdapterError):
    def __init__(self, kind: AdapterKind, reason: str | None = None) -> None:
        super().__init__(reason or f"no adapter is registered for interface kind {kind.value}")
        self.kind = kind


class AdapterRefusedError(UnsupportedAdapterError):
    pass


class StepRefusedError(AdapterError):
    def __init__(self, message: str, skip_reason: SkipReason) -> None:
        super().__init__(message)
        self.skip_reason = skip_reason


class InterfaceUnresolvedError(AdapterError):
    pass


class MissingPlaceholderError(AdapterError):
    def __init__(self, name: str) -> None:
        super().__init__(f"no value is set for ${{{name}}}")
        self.name = name


class CredentialsUnavailableError(AdapterError):
    pass


class LoginError(AdapterError):
    pass
