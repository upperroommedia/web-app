/**
 * Navbar: located at the top of all pages
 */
import { useContext, FunctionComponent } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import styles from '../styles/Navbar.module.css';
import UserContext from '../context/user/UserContext';

const Navbar: FunctionComponent = () => {
  const { user } = useContext(UserContext);
  return (
    <nav>
      <div className={styles.navbar}>
        <h1 className={styles.title}>Upper Room Media</h1>
        <Image
          src="/upper_room_media_icon.png"
          alt="Upper Room Media Logo"
          width="100%"
          height="100%"
        />
      </div>
      <Link href="/">
        <a className={styles.nav_link}>Home</a>
      </Link>
      <Link href="/sermons">
        <a className={styles.nav_link}>Sermons</a>
      </Link>
      <Link href="/about">
        <a className={styles.nav_link}>About</a>
      </Link>

      {!user.isAuthenticated ? (
        <>
          <Link href="/login">
            <a className={styles.nav_link}>Login</a>
          </Link>
          <Link href="/signup">
            <a className={styles.nav_link}>Sign Up</a>
          </Link>
        </>
      ) : (
        // All Pages that need to be protected
        <>
          <Link href="/uploader">
            <a className={styles.nav_link}>Uploader</a>
          </Link>
          <Link href="/logout">
            <a className={styles.nav_link}>Log out</a>
          </Link>
        </>
      )}
    </nav>
  );
};

export default Navbar;
