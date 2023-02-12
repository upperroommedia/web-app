/**
 * Footer located at the bottom of all pages
 */
import Image from 'next/image';
import { FunctionComponent } from 'react';
import styles from '../styles/Footer.module.css';

const Footer: FunctionComponent = () => (
  <footer className={styles.footer}>
    <p>
      Powered by{' '}
      <span className={styles.logo}>
        <Image src="/coptic-devs-logo.webp" alt="Coptic Devs Logo" width="100%" height="100%" />
      </span>
    </p>
  </footer>
);

export default Footer;
