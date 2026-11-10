declare module "*.graphql" {
  const query: string;
  export default query;
}

declare module "*.graphql?raw" {
  const query: string;
  export default query;
}
