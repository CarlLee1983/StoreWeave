// Synthetic R4 violation: a root definition whose manifest metadata carries a function.
// Typed `unknown` so a deliberately-invalid shape never fails `make typecheck`.
export const definition: unknown = {
  manifest: {
    id: 'fixture',
    version: '0.0.0',
    selected: { modules: [], themes: [], extensions: [] },
    targets: {},
    metadata: {
      build: () => 'x',
    },
  },
};
