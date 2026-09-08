# Admin primitive provenance

`dialog.tsx`, `dropdown-menu.tsx`, and `popover.tsx` are small source-distribution slices
of [shadcn/ui](https://ui.shadcn.com/docs), based on its
[Dialog](https://ui.shadcn.com/docs/components/dialog) and
[Dropdown Menu](https://ui.shadcn.com/docs/components/dropdown-menu), and
[Popover](https://ui.shadcn.com/docs/components/popover) recipes.
They retain Radix `Root`/`Portal`/`Content`/`Item` composition; only the
class names are mapped to this Admin's existing CSS tokens in
`src/enhancements.css`.

The Admin intentionally does not initialize the shadcn CLI or add
`components.json`: its Vite installation requires Tailwind and CSS aliases,
while this app has neither and a Tailwind reset would regress unmigrated
routes. These copied source slices use direct Radix package imports and the
only installed dependencies are `@radix-ui/react-dialog@1.1.23`,
`@radix-ui/react-dropdown-menu@2.1.24`, and
`@radix-ui/react-popover@1.1.23` (all support React 18).
