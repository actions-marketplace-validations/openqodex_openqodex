export type Product = { id: string; name: string; cents: number };

// Products whose name contains the query, from the catalog API.
export async function searchProducts(query: string): Promise<Product[]> {
  const res = await fetch(`/api/products?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`search failed: ${res.status}`);
  return (await res.json()) as Product[];
}
