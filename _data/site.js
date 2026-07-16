// Central site configuration — the single source of truth for nav, footer,
// CTAs, and SEO defaults. Edit here; every page picks it up on rebuild.
export default {
  name: "Product Pelican",
  tagline: "The Shopify-Native PIM for Agentic Commerce",
  url: "https://productpelican.com",
  logo: "https://cdn.shopify.com/s/files/1/0987/8267/5232/files/pelican-200.png?v=1776037749",
  gaId: "G-YRFJX7X5R6",
  defaultOgImage:
    "https://cdn.heymantle.com/orgs/26a47f7d-a3b9-42a0-97fc-a4835cc43fbe/docs-pages/video-frames/2c9501fa-e137-4f93-812c-c3f1b2e22b6d/frame_001.jpg",

  // Primary nav links. Anchors are absolute so they work from every page.
  navLinks: [
    { label: "What's new", href: "/#whats-new" },
    { label: "Free Audit", href: "/free-audit" },
    { label: "Product FAQs", href: "/product-faq-builder" },
    { label: "Playbook", href: "/#playbook" },
    { label: "Roadmap", href: "/#roadmap" },
    { label: "Blog", href: "/blog/" },
  ],

  // Call-to-action buttons rendered on the right of the nav.
  cta: {
    docs: "https://apps.nativeappco.com/product-pelican",
    install: "https://apps.shopify.com/product-pelican",
    calendly: "https://calendly.com/nativeappco-support/30min",
  },

  // Cross-sell apps shown in the footer.
  footerApps: [
    {
      href: "https://apps.shopify.com/fish-wishlist",
      img: "/fish-200.png",
      label: "Fish Wishlist & Quote Request",
    },
    {
      href: "https://apps.shopify.com/omnibus-price-radar",
      img: "/owly-200.png",
      label: "Omnibus Owl Price Tracker",
    },
    {
      href: "https://apps.shopify.com/stork-credit",
      img: "/storky-200.png",
      label: "Stork: Store Credit & Rewards",
    },
  ],

  // Footer social / external links.
  social: [
    { href: "https://theshopifyappshow.substack.com/", label: "The Shopify App Show" },
    { href: "https://www.linkedin.com/in/martincox100/", label: "LinkedIn" },
    { href: "https://x.com/martincox100", label: "X" },
  ],
};
