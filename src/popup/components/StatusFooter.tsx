import { useEffect, useState, useRef } from 'react';

interface Props {
  text: string;
  isLoading: boolean;
  isError: boolean;
}

export function StatusFooter({ text, isLoading, isError }: Props) {
  const [displayed, setDisplayed] = useState('');
  const [cursor, setCursor] = useState(true);
  const fullTextRef = useRef(text);
  const indexRef = useRef(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    fullTextRef.current = text;
    indexRef.current = 0;
    setDisplayed('');

    let lastTime = 0;
    const speed = 18;

    function animate(time: number) {
      if (time - lastTime < speed) {
        rafRef.current = requestAnimationFrame(animate);
        return;
      }
      lastTime = time;
      const full = fullTextRef.current;
      indexRef.current += 1;
      if (indexRef.current <= full.length) {
        setDisplayed(full.slice(0, indexRef.current));
        rafRef.current = requestAnimationFrame(animate);
      }
    }

    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [text]);

  useEffect(() => {
    const interval = setInterval(() => {
      setCursor((c) => !c);
    }, 530);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className={`status-footer ${isError ? 'status-footer--error' : ''} ${isLoading ? 'status-footer--loading' : ''}`}>
      <span className="status-footer-prefix">{isError ? '!' : '>'}</span>
      <span className="status-footer-text">
        {isLoading ? text : displayed}
      </span>
      <span className={`status-footer-cursor ${cursor ? 'visible' : ''}`}>▊</span>
    </div>
  );
}
