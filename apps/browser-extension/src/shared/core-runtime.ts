// Import first in every extension page / worker that uses @cira/core.
// MV3 forbids eval, so run Core's schema validation without Zod's JIT.
import { useStrictCspRuntime } from '@cira/core';

useStrictCspRuntime();
