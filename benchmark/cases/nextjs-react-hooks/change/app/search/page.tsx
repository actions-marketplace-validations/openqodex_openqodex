"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { searchProducts, type Product } from "../../lib/api";

export default function SearchPage() {
  const params = useSearchParams();
  const query = params.get("q");
  if (!query) {
    return <p>Type a search term.</p>;
  }
  const [results, setResults] = useState<Product[]>([]);

  useEffect(() => {
    searchProducts(query).then(setResults);
  });

  return (
    <main>
      <h1 dangerouslySetInnerHTML={{ __html: `Results for ${query}` }} />
      <ul>
        {results.map((product) => (
          <li>{product.name}</li>
        ))}
      </ul>
    </main>
  );
}
