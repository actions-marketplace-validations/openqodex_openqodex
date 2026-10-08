export function slugify(title: string): string {
  return title.trim().toLowerCase();
}

export function renderTitle(title: string, slugify: (t: string) => string): string {
  return slugify(title);
}

export function pageUrl(title: string): string {
  return `/p/${slugify(title)}`;
}
