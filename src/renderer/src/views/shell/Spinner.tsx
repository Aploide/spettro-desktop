// ProgressView stand-in: a plain indeterminate ring in the secondary color.

export default function Spinner({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <span
      className="spinner"
      role="progressbar"
      aria-label="Loading"
      style={{ width: size, height: size, borderWidth: Math.max(1.5, Math.round(size / 9)) }}
    />
  )
}
