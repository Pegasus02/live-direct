"""Independent public live providers (standard-library runtime)."""
from . import bilibili, douyin, douyu, huya
from .bilibili import Bilibili
from .douyin import Douyin
from .douyu import Douyu
from .huya import Huya

# Registry order is the admin navigation and playlist group order.
LABELS = {'douyin': '抖音', 'bilibili': 'B站', 'douyu': '斗鱼', 'huya': '虎牙'}

# Category shortcuts for the admin UI; IDs are what each provider accepts.
CATEGORIES = {'douyin': douyin.CATEGORIES, 'bilibili': bilibili.AREAS,
              'douyu': douyu.CATEGORIES, 'huya': huya.CATEGORIES}


def default_providers():
    return {'douyin': Douyin(), 'bilibili': Bilibili(), 'douyu': Douyu(), 'huya': Huya()}


__all__ = ['Bilibili', 'Douyin', 'Douyu', 'Huya', 'CATEGORIES', 'LABELS', 'default_providers']
