import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
// sonner-based Toaster — the app's toast() calls all come from "sonner";
// the radix toaster was mounted here historically, which made every toast invisible.
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "KeyForge Motion Studio — 浏览器动效设计工作台",
  description:
    "基于 InitialXKO/keyframe 引擎（Rust × WASM × WebGPU 架构，纯 JS 回退运行时）驱动的浏览器端动效设计工作台：关键帧编辑、时间轴、批量实例性能实验室与战略评估。",
  keywords: ["keyframe", "动效", "动画编辑器", "Motion Design", "WASM", "Remotion", "KeyForge"],
  authors: [{ name: "KeyForge Motion Studio" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "KeyForge Motion Studio",
    description: "由 keyframe 引擎驱动的浏览器动效设计工作台",
    siteName: "KeyForge Motion Studio",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
