/**
 * Documentation Provider
 * 
 * Provides essential, curated documentation for common libraries.
 * This is more reliable than depending on AI to call Context7.
 * Updated periodically to match latest stable versions.
 * 
 * Last updated: January 2026
 */

export interface LibraryDocs {
  name: string;
  version: string;
  setupInstructions: string;
  commonPitfalls: string[];
  essentialPatterns: string;
}

const LIBRARY_DOCS: Record<string, LibraryDocs> = {
  'next.js': {
    name: 'Next.js',
    version: '16.x',
    setupInstructions: `
## Next.js 16 Setup (CURRENT STABLE)

\`\`\`bash
npx create-next-app@latest my-app --yes
cd my-app
npm run dev
\`\`\`

Default options include:
- TypeScript enabled
- Tailwind CSS 4.x
- ESLint configured
- App Router (not Pages Router)
- Turbopack for dev server

### Project Structure (App Router)
\`\`\`
src/
  app/
    layout.tsx      # Root layout (required)
    page.tsx        # Home page
    globals.css     # Global styles
  components/
    ui/             # UI components (shadcn)
  lib/
    utils.ts        # Utility functions
\`\`\`
`,
    commonPitfalls: [
      'Do NOT use Pages Router patterns (pages/ directory) - use App Router (app/ directory)',
      'All components in app/ are Server Components by default - add "use client" for interactivity',
      'Use next/image for images, not <img> tags',
      'Use next/link for navigation, not <a> tags for internal links',
    ],
    essentialPatterns: `
### Client Components (for interactivity)
\`\`\`tsx
"use client";

import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
}
\`\`\`

### Server Components (default, for data fetching)
\`\`\`tsx
// No "use client" - this is a Server Component
async function getData() {
  const res = await fetch('https://api.example.com/data');
  return res.json();
}

export default async function Page() {
  const data = await getData();
  return <div>{data.title}</div>;
}
\`\`\`
`,
  },

  'shadcn/ui': {
    name: 'shadcn/ui',
    version: 'latest (2026)',
    setupInstructions: `
## shadcn/ui Setup

\`\`\`bash
npx shadcn@latest init
\`\`\`

When prompted, select:
- Style: **New York** (recommended)
- Base color: neutral
- CSS variables: yes

### Adding Components
\`\`\`bash
npx shadcn@latest add button
npx shadcn@latest add card
npx shadcn@latest add input
npx shadcn@latest add form
npx shadcn@latest add sheet
npx shadcn@latest add dialog
\`\`\`

### Usage
\`\`\`tsx
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export function MyComponent() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Title</CardTitle>
      </CardHeader>
      <CardContent>
        <Button>Click me</Button>
      </CardContent>
    </Card>
  );
}
\`\`\`
`,
    commonPitfalls: [
      'Always import from "@/components/ui/..." not from shadcn directly',
      'Components are copied to your project - they are YOUR code to customize',
      'Form components require react-hook-form and zod',
      'Sheet component is used for mobile menus (slide-out panels)',
    ],
    essentialPatterns: `
### Form with Validation
\`\`\`tsx
"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const formSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2),
});

export function ContactForm() {
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
  });

  function onSubmit(values: z.infer<typeof formSchema>) {
    console.log(values);
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit">Submit</Button>
      </form>
    </Form>
  );
}
\`\`\`
`,
  },

  'tailwindcss': {
    name: 'Tailwind CSS',
    version: '4.x',
    setupInstructions: `
## Tailwind CSS 4 (CURRENT STABLE)

Tailwind 4 uses a new CSS-first configuration approach.

### globals.css structure
\`\`\`css
@import "tailwindcss";

@theme {
  --color-primary: #3b82f6;
  --color-background: #ffffff;
  --color-foreground: #0a0a0a;
  /* Define your design tokens here */
}

@layer base {
  body {
    background-color: var(--color-background);
    color: var(--color-foreground);
  }
}
\`\`\`

### Key Changes from v3
- Use \`@import "tailwindcss"\` instead of \`@tailwind base/components/utilities\`
- Use \`@theme\` block for CSS variables instead of tailwind.config.js theme
- No more \`tailwind.config.js\` needed for most projects
`,
    commonPitfalls: [
      'Do NOT use @apply with CSS variable utilities like border-border - use inline classes',
      'Do NOT use tailwind.config.js for colors - use @theme in CSS',
      'The @theme block replaces most tailwind.config.js customization',
      'Content paths are auto-detected - no need for content config',
    ],
    essentialPatterns: `
### Common Utility Classes
\`\`\`tsx
// Layout
<div className="flex items-center justify-between">
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">

// Spacing
<div className="p-4 m-2">  // padding and margin
<div className="space-y-4">  // vertical spacing between children

// Typography
<h1 className="text-4xl font-bold tracking-tight">
<p className="text-muted-foreground">

// Colors (using CSS variables)
<div className="bg-primary text-primary-foreground">
<div className="bg-card text-card-foreground">

// Responsive
<div className="text-sm md:text-base lg:text-lg">
\`\`\`
`,
  },

  'framer-motion': {
    name: 'Framer Motion',
    version: '12.x (motion package)',
    setupInstructions: `
## Framer Motion / Motion Setup

\`\`\`bash
npm install motion
\`\`\`

### Import (NEW in v12+)
\`\`\`tsx
// Use motion/react, NOT framer-motion
import { motion } from "motion/react";
\`\`\`
`,
    commonPitfalls: [
      'Import from "motion/react" NOT "framer-motion"',
      'ease property must be typed correctly - use arrays [0.4, 0, 0.2, 1] not strings',
      'Add "use client" directive - motion components need client-side JS',
      'Variants type requires proper easing - avoid ease: "easeOut" string literal',
    ],
    essentialPatterns: `
### Correct Animation Patterns
\`\`\`tsx
"use client";

import { motion, type Variants } from "motion/react";

// CORRECT: Use array for easing
const fadeInUp: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.5,
      ease: [0.4, 0, 0.2, 1], // cubic-bezier, NOT "easeOut" string
    },
  },
};

// CORRECT: Stagger children
const container: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
    },
  },
};

export function AnimatedList({ items }: { items: string[] }) {
  return (
    <motion.ul
      variants={container}
      initial="hidden"
      animate="visible"
    >
      {items.map((item, i) => (
        <motion.li key={i} variants={fadeInUp}>
          {item}
        </motion.li>
      ))}
    </motion.ul>
  );
}
\`\`\`

### Scroll-triggered animations
\`\`\`tsx
<motion.div
  initial={{ opacity: 0, y: 50 }}
  whileInView={{ opacity: 1, y: 0 }}
  viewport={{ once: true, margin: "-100px" }}
  transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
>
  Content appears on scroll
</motion.div>
\`\`\`
`,
  },

  'react': {
    name: 'React',
    version: '19.x',
    setupInstructions: `
## React 19 (CURRENT STABLE)

React 19 is included with Next.js 16 by default.

### Key Features
- Improved Server Components
- Actions for form handling
- use() hook for promises
- Document metadata support
`,
    commonPitfalls: [
      'Server Components cannot use hooks (useState, useEffect, etc.)',
      'Client Components need "use client" directive at top of file',
      'Hooks must be called at top level, not in conditions or loops',
    ],
    essentialPatterns: `
### Hooks Reference
\`\`\`tsx
"use client";

import { useState, useEffect, useCallback, useMemo } from "react";

// State
const [value, setValue] = useState(initialValue);

// Side effects
useEffect(() => {
  // runs after render
  return () => { /* cleanup */ };
}, [dependencies]);

// Memoization
const memoizedValue = useMemo(() => computeExpensive(a, b), [a, b]);
const memoizedCallback = useCallback(() => doSomething(a), [a]);
\`\`\`
`,
  },
};

/**
 * Get documentation for specific libraries
 */
export function getLibraryDocs(libraries: string[]): string {
  const sections: string[] = [];
  
  sections.push('## 📚 Essential Documentation (Curated & Current)\n');
  sections.push('> This documentation is curated and up-to-date. Use these patterns, not outdated training data.\n');
  
  for (const lib of libraries) {
    const libKey = lib.toLowerCase().replace(/\s+/g, '');
    const docs = LIBRARY_DOCS[libKey] || LIBRARY_DOCS[lib.toLowerCase()];
    
    if (docs) {
      sections.push(`\n### ${docs.name} (v${docs.version})\n`);
      sections.push(docs.setupInstructions);
      
      if (docs.commonPitfalls.length > 0) {
        sections.push('\n**⚠️ Common Pitfalls - AVOID THESE:**');
        docs.commonPitfalls.forEach(p => sections.push(`- ${p}`));
      }
      
      sections.push('\n**Essential Patterns:**');
      sections.push(docs.essentialPatterns);
    }
  }
  
  return sections.join('\n');
}

/**
 * Get all available library names
 */
export function getAvailableLibraries(): string[] {
  return Object.keys(LIBRARY_DOCS);
}

/**
 * Detect which libraries are likely used in the project
 */
export async function detectProjectLibraries(): Promise<string[]> {
  const detected: string[] = [];
  const fs = await import('fs-extra');
  const path = await import('path');
  
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  
  if (await fs.pathExists(packageJsonPath)) {
    try {
      const pkg = await fs.readJson(packageJsonPath);
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      
      if (allDeps['next']) detected.push('next.js');
      if (allDeps['react']) detected.push('react');
      if (allDeps['tailwindcss']) detected.push('tailwindcss');
      if (allDeps['motion'] || allDeps['framer-motion']) detected.push('framer-motion');
      
      // Check for shadcn by looking for components.json
      const componentsJsonPath = path.join(process.cwd(), 'components.json');
      if (await fs.pathExists(componentsJsonPath)) {
        detected.push('shadcn/ui');
      }
    } catch {
      // Ignore errors
    }
  }
  
  return detected;
}
