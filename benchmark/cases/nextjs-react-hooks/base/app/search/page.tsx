export default function SearchPage() {
  return (
    <main>
      <h1>Search</h1>
      <form action="/search">
        <input name="q" placeholder="Search products" />
        <button type="submit">Search</button>
      </form>
    </main>
  );
}
