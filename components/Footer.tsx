/**
 * Footer located at the bottom of all pages
 */
import Image from 'next/image';
import Link from 'next/link';
import { FunctionComponent } from 'react';
import styles from '../styles/Footer.module.css';

const Footer: FunctionComponent = () => (
  <footer className={styles.footer}>
    <Link href="https://forms.gle/5Nw35vnq6JUkHEe59" target="_blank" rel="noopener noreferrer" className={styles.link}>
      Give us feedback!
    </Link>
    <div>
      <p>
        Powered by{' '}
        <span className={styles.logo}>
          <Image
            src="/coptic-devs-logo.webp"
            alt="Coptic Devs Logo"
            fill
            sizes="36px, 36px"
            style={{ objectFit: 'cover' }}
          />
        </span>
      </p>
    </div>
  </footer>
);

export default Footer;
