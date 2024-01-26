// import Box from '@mui/system/Box'
import React, { useCallback, useState } from 'react';
import Marquee from 'react-fast-marquee';

interface MarqueeComponentProps {
  children: React.ReactNode;
}

export default function MarqueeComponent({ children }: MarqueeComponentProps) {
  const [playMarquee, _setPlayMarquee] = useState(true);
  const [marqueeSleep, setMarqueeSleep] = useState(false);

  // const marqueeContentRef = useRef<HTMLDivElement>(null);
  // const marqueeRef = useRef<HTMLDivElement>(null);

  // const checkOverflow = () => {
  //     const typographyWidth = marqueeContentRef.current?.clientWidth || 0;
  //     const marqueeWidth = marqueeRef.current?.clientWidth || 0;

  //     if (typographyWidth > marqueeWidth) {
  //         setPlayMarquee(true);
  //     } else {
  //         setPlayMarquee(false);
  //     }
  // };

  const marqueeRefCallback = useCallback((node: HTMLDivElement) => {
    console.log('ClientWidth', node.clientWidth);
    console.log('ScrollWidth', node.scrollWidth);
  }, []);

  // useLayoutEffect(() => {
  //     console.log("marqueeRef div", marqueeRef.current)
  //     checkOverflow(); // Check overflow initially

  //     const handleResize = () => {
  //         checkOverflow(); // Re-check overflow on window resize
  //     };

  //     window.addEventListener('resize', handleResize);

  //     return () => {
  //         window.removeEventListener('resize', handleResize);
  //     };
  // }, [marqueeRef]);

  const handleCycleComplete = () => {
    setMarqueeSleep(true); // Pause the marquee when the cycle ends
    setTimeout(() => {
      setMarqueeSleep(true); // Resume the marquee after 5 seconds
    }, 5000); // 5 seconds = 5000 milliseconds
  };
  return (
    <Marquee
      ref={marqueeRefCallback}
      style={{ width: 'min-content' }}
      play={playMarquee && !marqueeSleep}
      delay={5}
      onCycleComplete={handleCycleComplete}
    >
      <div style={{ width: '200px' }}>{children}</div>
    </Marquee>
  );
}
