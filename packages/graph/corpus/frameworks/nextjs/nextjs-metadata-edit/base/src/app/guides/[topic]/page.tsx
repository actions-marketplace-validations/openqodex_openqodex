export default async function Guide({ params }: { params: Promise<{ topic: string }> }) {
  const { topic } = await params;
  return <h1>{topic}</h1>;
}
