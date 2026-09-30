// Vite worker URL imports are build-time assets, not executable module imports.
declare module "*?worker&url" {
  const url: string;
  export default url;
}
