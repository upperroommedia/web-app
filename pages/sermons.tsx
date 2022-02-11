/**
 * Sermons page for viewing all sermons test
 */
import type { NextPage } from 'next';
import Footer from '../components/Footer';
import Navbar from '../components/Navbar';
import styles from '../styles/Home.module.css';

const Sermons: NextPage = () => (
  <div className={styles.container}>
    <Navbar />
    <h1>Sermons</h1>
    <Footer />
  </div>
);

export default Sermons;
