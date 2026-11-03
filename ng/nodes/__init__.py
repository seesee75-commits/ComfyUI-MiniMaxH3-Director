"""Thin V3 nodes. They read inputs, call core and adapters, and return; no domain logic lives here."""
from . import routes  # noqa: F401  (registers /ng/plan)
from . import context_routes  # noqa: F401
from . import analysis_routes  # noqa: F401
from .chunk_node import NODES as _CHUNK
from .context_nodes import NODES as _CONTEXT
from .director_node import NODES as _DIRECTOR
from .render_node import NODES as _RENDER
from .studio_node import NODES as _STUDIO
from .provider_node import NODES as _PROVIDER
from .connector_node import NODES as _CONNECTOR
from .product_director_node import NODES as _PRODUCT
from .output_node import NODES as _OUTPUT
from .preview_node import NODES as _PREVIEW
from .ai_nodes import NODES as _AI
from .control_node import NODES as _CONTROL
from .storyboard_node import NODES as _STORYBOARD
from .still_node import NODES as _STILL
from .guide_node import NODES as _GUIDE

NODES = _CONTEXT +_DIRECTOR + _CHUNK + _RENDER + _STUDIO + _PROVIDER + _CONNECTOR + _PRODUCT + _OUTPUT + _PREVIEW + _AI + _CONTROL + _STORYBOARD + _STILL + _GUIDE
