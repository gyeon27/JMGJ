import dynamic from "next/dynamic";

const SkyViewer = dynamic(
  () => import("../components/SkyViewer"),
  { ssr: false }
);

export default function Home() {
  return <SkyViewer />;
}