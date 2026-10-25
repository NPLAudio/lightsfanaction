import { HybridBackend } from './hybrid'

// Hardware providers plug in by implementing `Backend` (see types.ts).
export const backend = new HybridBackend()
export const sim = backend.sim
