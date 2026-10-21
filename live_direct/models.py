"""Small provider/backend value objects; signed stream addresses are never repr'd."""
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Channel:
    platform: str
    room_id: str
    name: str
    title: str = ''
    logo: str = ''


@dataclass(frozen=True)
class Stream:
    url: str = field(repr=False)
    format: str
    quality: str = ''
    headers: dict = field(default_factory=dict, repr=False)


class ProviderError(ValueError):
    """Safe fixed-text operational error, with no upstream messages or URLs."""


class RoomOfflineError(ProviderError):
    pass
