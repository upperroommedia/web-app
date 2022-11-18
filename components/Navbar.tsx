/**
 * Navbar: located at the top of all pages
 */
import { FunctionComponent } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import styles from '../styles/Navbar.module.css';
import useAuth from '../context/user/UserContext';
import { useRouter } from 'next/router';

const Navbar: FunctionComponent = () => {
  const { user } = useAuth();
  const displayName = user?.displayName || user?.email;
  const photoSrc = user?.photoURL || '/user.png';
  const path = useRouter().asPath;
  return (
    <nav>
      <div className={styles.navbar}>
        <div className={styles.navbar_header_container}>
          <h1 className={styles.title}>Upper Room Media</h1>
          <Image src="/upper_room_media_icon.png" alt="Upper Room Media Logo" width="100%" height="100%" />
        </div>
        {user && (
          <Link href="/profile">
            <div className={styles.user_info} style={{ cursor: 'pointer' }}>
              <div className={styles.profile_pic}>
                <Image src={photoSrc} layout="fill" alt="User profile picture"></Image>
              </div>
              <p>{displayName}</p>
            </div>
          </Link>
        )}
      </div>
      <div className={styles.navbar_links}>
        <Link href="/">
          <a
            className={styles.nav_link}
            style={{
              color: path === '/' ? 'blue' : 'black',
              textDecoration: path === '/' ? 'underline' : 'none',
            }}
          >
            Home
          </a>
        </Link>
        <Link href="/sermons">
          <a
            className={styles.nav_link}
            style={{
              color: path === '/sermons' ? 'blue' : 'black',
              textDecoration: path === '/sermons' ? 'underline' : 'none',
            }}
          >
            Sermons
          </a>
        </Link>
        <Link href="/about">
          <a
            className={styles.nav_link}
            style={{
              color: path === '/about' ? 'blue' : 'black',
              textDecoration: path === '/about' ? 'underline' : 'none',
            }}
          >
            About
          </a>
        </Link>
        <>
          {user?.role === 'admin' ? (
            <>
              <Link href="/uploader">
                <a
                  className={styles.nav_link}
                  style={{
                    color: path === '/uploader' ? 'blue' : 'black',
                    textDecoration: path === '/uploader' ? 'underline' : 'none',
                  }}
                >
                  Uploader
                </a>
              </Link>
              <Link href="/admin">
                <a
                  className={styles.nav_link}
                  style={{
                    color: path === '/admin' ? 'blue' : 'black',
                    textDecoration: path === '/admin' ? 'underline' : 'none',
                  }}
                >
                  Admin
                </a>
              </Link>
            </>
          ) : (
            <></>
          )}
          {user && (
            <Link href="/logout">
              <a className={styles.nav_link}>Log out</a>
            </Link>
          )}
        </>
      </div>
    </nav>
  );
};

export default Navbar;
