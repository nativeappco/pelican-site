import { feedPlugin } from "@11ty/eleventy-plugin-rss";

export default function (eleventyConfig) {
  // Register the RSS/Atom feed plugin (used by feed.njk).
  eleventyConfig.addPlugin(feedPlugin, {
    type: "atom",
    outputPath: "/feed.xml",
    collection: { name: "posts", limit: 20 },
    metadata: {
      language: "en",
      title: "Product Pelican Blog",
      subtitle:
        "Field notes on Shopify PIM, product data, GEO, and agentic commerce.",
      base: "https://productpelican.com/",
      author: { name: "Native App Co" },
    },
  });

  // --- Passthrough copy: assets ship to _site untouched ---
  eleventyConfig.addPassthroughCopy("global.css");
  eleventyConfig.addPassthroughCopy("robots.txt");
  eleventyConfig.addPassthroughCopy("roadshow"); // standalone microsite, copied verbatim
  ["png", "jpg", "jpeg", "gif", "svg", "mp4", "webp", "ico", "webmanifest"].forEach(
    (ext) => eleventyConfig.addPassthroughCopy(`*.${ext}`)
  );

  // --- Filters ---
  // Human-readable post date, e.g. "July 15, 2026".
  eleventyConfig.addFilter("postDate", (value) => {
    const d = value instanceof Date ? value : new Date(value);
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  });
  // ISO date for <time datetime> and sitemap <lastmod>.
  eleventyConfig.addFilter("isoDate", (value) => {
    const d = value instanceof Date ? value : new Date(value);
    return d.toISOString();
  });

  return {
    dir: {
      input: ".",
      output: "_site",
      includes: "_includes",
      data: "_data",
    },
    // Process .html and .md pages through Nunjucks so shared layouts/partials work.
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk",
    templateFormats: ["njk", "md", "html"],
  };
}
