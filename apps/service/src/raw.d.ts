declare module '*.py?raw' {
  const source: string;
  export default source;
}

declare module '*.cjs?raw' {
  const source: string;
  export default source;
}
